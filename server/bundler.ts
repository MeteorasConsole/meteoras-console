import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto'
import {
  DynamicBondingCurveClient,
  SwapMode,
  getCurrentPoint,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import bs58 from 'bs58'
import {
  BundlerDryRunRequest,
  ExecuteBundlerRequest,
} from './schema'
import { loadPersistedState, persistPartialState } from './stateStore'

const DRY_RUN_TTL_MS = 5 * 60_000
const MAX_BUNDLE_WALLETS = Number(process.env.BUNDLER_MAX_WALLETS ?? 30)
const DEFAULT_GAS_BUFFER_SOL = Number(process.env.BUNDLER_GAS_BUFFER_SOL ?? 0.005)
const FUNDING_TRANSFERS_PER_TX = 10

type PreparedTransaction = {
  name: string
  base64: string
  requiredSigners: string[]
  signedByServer: string[]
}

type BundleWallet = {
  publicKey: string
  // base58 secret key, AES-256-GCM encrypted when BUNDLER_KEY_SECRET is set
  // (stored as enc:v1:<ivB64>:<tagB64>:<cipherB64>), otherwise stored raw.
  secretKey: string
}

type BundleEstimate = {
  walletCount: number
  targetSupplyPercent: number
  percentOfSupply: number
  targetTokens: string
  estimatedTokensOut: string
  perWalletBuySol: number
  perWalletGasSol: number
  totalBuySol: number
  totalFundingSol: number
}

type StoredBundle = {
  bundleId: string
  payloadHash: string
  createdAt: number
  submittedAt?: number
  fundingWallet: string
  poolAddress: string
  configAddress: string
  baseMint: string
  quoteMint: string
  walletCount: number
  targetSupplyPercent: number
  slippageBps: number
  perWalletBuyLamports: string
  perWalletGasLamports: string
  fundingBlockhash: string
  fundingLastValidBlockHeight: number
  wallets: BundleWallet[]
  fundingTransactions: PreparedTransaction[]
  estimate: BundleEstimate
  fundingSignatures?: string[]
  buyResults?: Array<{ wallet: string; signature?: string; error?: string }>
}

type StateFile = {
  bundles?: StoredBundle[]
}

const bundles = new Map<string, StoredBundle>()
let stateLoaded = false

export async function createBundlerDryRun(request: BundlerDryRunRequest) {
  await ensureStateLoaded()

  const walletCount = Math.floor(request.walletCount)
  if (walletCount < 1 || walletCount > MAX_BUNDLE_WALLETS) {
    return blocked(`Wallet count must be between 1 and ${MAX_BUNDLE_WALLETS}.`)
  }
  if (request.targetSupplyPercent <= 0 || request.targetSupplyPercent > 100) {
    return blocked('Target supply percent must be between 0 and 100.')
  }

  const env = readRuntimeEnv()
  const connection = new Connection(env.rpcUrl, 'confirmed')
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  let funder: PublicKey
  let pool: PublicKey
  try {
    funder = new PublicKey(request.fundingWallet)
    pool = new PublicKey(request.poolAddress)
  } catch {
    return blocked('Funding wallet and pool address must be valid Solana public keys.')
  }

  // getPool/getPoolConfig throw (e.g. "Invalid account discriminator") when the
  // address is not a DBC pool, so treat any failure as "not a pool".
  let virtualPool: Awaited<ReturnType<typeof client.state.getPool>>
  let config: Awaited<ReturnType<typeof client.state.getPoolConfig>>
  let poolState: any
  try {
    virtualPool = await client.state.getPool(pool)
    if (!virtualPool) return blocked('Pool not found. Confirm the DBC pool address for the launched token.')
    // The VirtualPool account wraps its data under `poolState` (typed loosely by
    // the anchor IDL), so the config/baseMint live there.
    poolState = virtualPool.poolState
    config = await client.state.getPoolConfig(new PublicKey(poolState.config))
  } catch (error) {
    return blocked(
      `Could not read this address as a Meteora DBC pool: ${
        error instanceof Error ? error.message : String(error)
      }. Paste the DBC pool address of your launched token.`,
    )
  }
  if (!config) {
    return blocked('Pool config not found for this pool.')
  }

  const totalSupply = new BN(config.preMigrationTokenSupply.toString())
  if (totalSupply.isZero()) {
    return blocked('Pool reports zero pre-migration supply; cannot size a supply target.')
  }

  const targetBps = Math.round(request.targetSupplyPercent * 100)
  const targetTokens = totalSupply.mul(new BN(targetBps)).div(new BN(10_000))
  if (targetTokens.isZero()) {
    return blocked('Target supply percent rounds to zero tokens. Increase the percent.')
  }

  const slippageBps = clampSlippage(request.slippageBps)
  const currentPoint = await getCurrentPoint(connection, config.activationType)

  let totalBuyLamports: BN
  let estimatedTokensOut: BN
  try {
    // SwapQuote2Result is loosely typed by the IDL; read the ExactOut fields off any.
    const quote: any = client.pool.swapQuote2({
      virtualPool,
      config,
      swapBaseForQuote: false,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
      slippageBps,
      swapMode: SwapMode.ExactOut,
      amountOut: targetTokens,
    })
    // ExactOut returns the max SOL needed (slippage-padded) for the target tokens.
    totalBuyLamports = new BN((quote.maximumAmountIn ?? quote.amountIn ?? new BN(0)).toString())
    estimatedTokensOut = new BN((quote.outputAmount ?? targetTokens).toString())
  } catch (error) {
    return blocked(
      `Could not quote ${request.targetSupplyPercent}% of supply on this curve: ${
        error instanceof Error ? error.message : String(error)
      }. The target may exceed the curve's pre-migration capacity.`,
    )
  }

  if (totalBuyLamports.isZero()) {
    return blocked('Quote returned zero SOL for the target. Increase the target percent.')
  }

  const perWalletBuyLamports = ceilDiv(totalBuyLamports, walletCount)
  const perWalletGasLamports = new BN(Math.round(DEFAULT_GAS_BUFFER_SOL * LAMPORTS_PER_SOL))
  const perWalletFundingLamports = perWalletBuyLamports.add(perWalletGasLamports)

  const wallets = Array.from({ length: walletCount }, () => Keypair.generate())
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const fundingTransactions = buildFundingTransactions(
    funder,
    wallets.map((wallet) => wallet.publicKey),
    perWalletFundingLamports,
    blockhash,
  )

  const estimate: BundleEstimate = {
    walletCount,
    targetSupplyPercent: request.targetSupplyPercent,
    percentOfSupply: bnRatioPercent(estimatedTokensOut, totalSupply),
    targetTokens: targetTokens.toString(),
    estimatedTokensOut: estimatedTokensOut.toString(),
    perWalletBuySol: lamportsToSol(perWalletBuyLamports),
    perWalletGasSol: lamportsToSol(perWalletGasLamports),
    totalBuySol: lamportsToSol(perWalletBuyLamports.muln(walletCount)),
    totalFundingSol: lamportsToSol(perWalletFundingLamports.muln(walletCount)),
  }

  const payload = {
    backendFunction: 'meteora_dbc_bundle_buy',
    fundingWallet: funder.toBase58(),
    pool: pool.toBase58(),
    walletCount,
    targetSupplyPercent: request.targetSupplyPercent,
    slippageBps,
    perWalletFundingLamports: perWalletFundingLamports.toString(),
    walletPublicKeys: wallets.map((wallet) => wallet.publicKey.toBase58()),
  }
  const payloadHash = hashJson(payload)
  const bundleId = randomUUID()

  bundles.set(bundleId, {
    bundleId,
    payloadHash,
    createdAt: Date.now(),
    fundingWallet: funder.toBase58(),
    poolAddress: pool.toBase58(),
    configAddress: new PublicKey(poolState.config).toBase58(),
    baseMint: new PublicKey(poolState.baseMint).toBase58(),
    quoteMint: new PublicKey(config.quoteMint).toBase58(),
    walletCount,
    targetSupplyPercent: request.targetSupplyPercent,
    slippageBps,
    perWalletBuyLamports: perWalletBuyLamports.toString(),
    perWalletGasLamports: perWalletGasLamports.toString(),
    fundingBlockhash: blockhash,
    fundingLastValidBlockHeight: lastValidBlockHeight,
    wallets: wallets.map((wallet) => ({
      publicKey: wallet.publicKey.toBase58(),
      secretKey: encryptSecret(bs58.encode(wallet.secretKey)),
    })),
    fundingTransactions,
    estimate,
  })
  await persistState()

  return {
    bundleId,
    status: 'prepared' as const,
    payloadHash,
    pool: pool.toBase58(),
    fundingWallet: funder.toBase58(),
    walletPublicKeys: wallets.map((wallet) => wallet.publicKey.toBase58()),
    estimate,
    fundingTransactions,
    keysEncrypted: isEncryptionEnabled(),
    warnings: buildWarnings(estimate),
  }
}

export async function executeBundler(request: ExecuteBundlerRequest) {
  await ensureStateLoaded()
  const stored = bundles.get(request.bundleId)
  if (!stored) {
    return { bundleId: request.bundleId, status: 'blocked' as const, error: 'Unknown bundle id. Run the bundler dry-run again.' }
  }
  if (request.approvedPayloadHash !== stored.payloadHash) {
    return { bundleId: stored.bundleId, status: 'blocked' as const, error: 'Approved payload hash does not match the latest bundle dry-run.' }
  }
  if (request.signerWallet !== stored.fundingWallet) {
    return { bundleId: stored.bundleId, status: 'blocked' as const, error: 'Funding transactions must be signed by the connected funding wallet from the dry-run.' }
  }
  if (Date.now() - stored.createdAt > DRY_RUN_TTL_MS) {
    return { bundleId: stored.bundleId, status: 'blocked' as const, error: 'Bundle funding blockhash is stale. Run the bundler dry-run again for fresh transactions.' }
  }
  if (process.env.ALLOW_MAINNET_EXECUTE !== 'true') {
    return { bundleId: stored.bundleId, status: 'blocked' as const, error: 'Transaction submission is disabled. Set ALLOW_MAINNET_EXECUTE=true only after production execution is explicitly approved.' }
  }
  if (!request.signedFundingTransactionsBase64?.length) {
    return { bundleId: stored.bundleId, status: 'blocked' as const, error: 'Signed funding transactions are required for execution.' }
  }
  if (request.signedFundingTransactionsBase64.length !== stored.fundingTransactions.length) {
    return { bundleId: stored.bundleId, status: 'blocked' as const, error: 'Signed funding transaction count does not match the prepared funding transaction count.' }
  }

  const env = readRuntimeEnv()
  const connection = new Connection(env.rpcUrl, 'confirmed')

  // 1. Fund the bundle wallets from the connected wallet.
  const fundingSignatures: string[] = []
  for (const encoded of request.signedFundingTransactionsBase64) {
    const signature = await connection.sendRawTransaction(Buffer.from(encoded, 'base64'), { skipPreflight: false })
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash: stored.fundingBlockhash, lastValidBlockHeight: stored.fundingLastValidBlockHeight },
      'confirmed',
    )
    if (confirmation.value.err) {
      stored.fundingSignatures = fundingSignatures
      await persistState()
      return {
        bundleId: stored.bundleId,
        status: 'blocked' as const,
        fundingSignatures,
        error: `Funding transaction failed confirmation: ${JSON.stringify(confirmation.value.err)}`,
      }
    }
    fundingSignatures.push(signature)
  }
  stored.fundingSignatures = fundingSignatures

  // 2. Build + sign each bundle wallet's buy against fresh pool state, then fire
  //    them all at once (rapid-fire v1 — no Jito atomicity).
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const pool = new PublicKey(stored.poolAddress)
  let virtualPool: Awaited<ReturnType<typeof client.state.getPool>>
  let config: Awaited<ReturnType<typeof client.state.getPoolConfig>>
  try {
    virtualPool = await client.state.getPool(pool)
    config = virtualPool ? await client.state.getPoolConfig(new PublicKey(virtualPool.poolState.config)) : null
  } catch (error) {
    virtualPool = null
    config = null
    void error
  }
  if (!virtualPool || !config) {
    await persistState()
    return {
      bundleId: stored.bundleId,
      status: 'blocked' as const,
      fundingSignatures,
      error: 'Wallets were funded but the pool/config could not be read to build buys. Export keys to recover the SOL.',
    }
  }

  const amountIn = new BN(stored.perWalletBuyLamports)
  const currentPoint = await getCurrentPoint(connection, config.activationType)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()

  const signedBuys: Array<{ wallet: string; raw?: Buffer; error?: string }> = []
  for (const wallet of stored.wallets) {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(decryptSecret(wallet.secretKey)))
      const quote = client.pool.swapQuote({
        virtualPool,
        config,
        swapBaseForQuote: false,
        amountIn,
        slippageBps: stored.slippageBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint,
      })
      const tx = await client.pool.swap({
        owner: keypair.publicKey,
        pool,
        amountIn,
        minimumAmountOut: quote.minimumAmountOut,
        swapBaseForQuote: false,
        referralTokenAccount: null,
        payer: keypair.publicKey,
      })
      tx.feePayer = keypair.publicKey
      tx.recentBlockhash = blockhash
      tx.sign(keypair)
      signedBuys.push({ wallet: wallet.publicKey, raw: tx.serialize() })
    } catch (error) {
      signedBuys.push({ wallet: wallet.publicKey, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const sent = await Promise.all(
    signedBuys.map(async (entry) => {
      if (!entry.raw) return { wallet: entry.wallet, error: entry.error ?? 'Buy transaction was not built.' }
      try {
        const signature = await connection.sendRawTransaction(entry.raw, { skipPreflight: false })
        return { wallet: entry.wallet, signature }
      } catch (error) {
        return { wallet: entry.wallet, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  const buyResults = await Promise.all(
    sent.map(async (entry) => {
      if (!entry.signature) return entry
      try {
        const confirmation = await connection.confirmTransaction(
          { signature: entry.signature, blockhash, lastValidBlockHeight },
          'confirmed',
        )
        if (confirmation.value.err) {
          return { wallet: entry.wallet, signature: entry.signature, error: JSON.stringify(confirmation.value.err) }
        }
        return entry
      } catch (error) {
        return { wallet: entry.wallet, signature: entry.signature, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  stored.buyResults = buyResults
  stored.submittedAt = Date.now()
  await persistState()

  const confirmed = buyResults.filter((entry) => entry.signature && !entry.error).length
  return {
    bundleId: stored.bundleId,
    status: confirmed > 0 ? ('submitted' as const) : ('blocked' as const),
    fundingSignatures,
    buyResults,
    summary: { wallets: buyResults.length, confirmed, failed: buyResults.length - confirmed },
    error: confirmed > 0 ? undefined : 'No bundle buys confirmed. Wallets were funded; export keys to recover the SOL.',
  }
}

// Returns decrypted base58 secret keys so the operator can recover/drain the
// bundle wallets. Whoever can call this controls the wallets.
export async function exportBundleKeys(bundleId: string) {
  await ensureStateLoaded()
  const stored = bundles.get(bundleId)
  if (!stored) return null

  return {
    bundleId: stored.bundleId,
    pool: stored.poolAddress,
    fundingWallet: stored.fundingWallet,
    createdAt: stored.createdAt,
    wallets: stored.wallets.map((wallet) => ({
      publicKey: wallet.publicKey,
      secretKey: decryptSecret(wallet.secretKey),
    })),
  }
}

function buildFundingTransactions(
  funder: PublicKey,
  destinations: PublicKey[],
  perWalletLamports: BN,
  blockhash: string,
): PreparedTransaction[] {
  const lamports = BigInt(perWalletLamports.toString())
  const transactions: PreparedTransaction[] = []

  for (let start = 0; start < destinations.length; start += FUNDING_TRANSFERS_PER_TX) {
    const batch = destinations.slice(start, start + FUNDING_TRANSFERS_PER_TX)
    const tx = new Transaction()
    tx.feePayer = funder
    tx.recentBlockhash = blockhash
    for (const destination of batch) {
      tx.add(SystemProgram.transfer({ fromPubkey: funder, toPubkey: destination, lamports }))
    }

    const index = Math.floor(start / FUNDING_TRANSFERS_PER_TX) + 1
    const total = Math.ceil(destinations.length / FUNDING_TRANSFERS_PER_TX)
    transactions.push({
      name: total > 1 ? `fundBundleWallets ${index}/${total}` : 'fundBundleWallets',
      base64: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
      requiredSigners: [funder.toBase58()],
      signedByServer: [],
    })
  }

  return transactions
}

function buildWarnings(estimate: BundleEstimate): string[] {
  return [
    'Bundle buys are fired rapid-fire right after the pool confirms; they are not atomic, so a sniper can theoretically land between them.',
    `Funding moves ~${estimate.totalFundingSol.toFixed(4)} SOL from the connected wallet into ${estimate.walletCount} fresh wallets. Submission stays guarded by ALLOW_MAINNET_EXECUTE.`,
    'Download the bundle wallet keys after preparing — they are the only way to recover the SOL/tokens in those wallets.',
  ]
}

function blocked(error: string) {
  return { bundleId: randomUUID(), status: 'blocked' as const, error }
}

async function ensureStateLoaded() {
  if (stateLoaded) return
  stateLoaded = true
  try {
    const state = (await loadPersistedState()) as StateFile
    for (const bundle of state.bundles ?? []) {
      bundles.set(bundle.bundleId, bundle)
    }
  } catch (error) {
    console.warn('[meteoras-console-api] failed to load persisted bundler state', error)
  }
}

async function persistState() {
  await persistPartialState({ bundles: Array.from(bundles.values()) })
}

function readRuntimeEnv() {
  return { rpcUrl: process.env.RPC_URL ?? 'https://api.devnet.solana.com' }
}

function clampSlippage(slippageBps: number | undefined): number {
  if (!slippageBps || !Number.isFinite(slippageBps)) return 500
  return Math.max(10, Math.min(5_000, Math.round(slippageBps)))
}

function ceilDiv(value: BN, divisor: number): BN {
  const d = new BN(divisor)
  return value.add(d).subn(1).div(d)
}

function lamportsToSol(lamports: BN): number {
  return Number(lamports.toString()) / LAMPORTS_PER_SOL
}

function bnRatioPercent(part: BN, whole: BN): number {
  if (whole.isZero()) return 0
  return (Number(part.mul(new BN(1_000_000)).div(whole).toString()) / 1_000_000) * 100
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isEncryptionEnabled(): boolean {
  return Boolean(process.env.BUNDLER_KEY_SECRET)
}

function deriveEncryptionKey(): Buffer {
  return scryptSync(process.env.BUNDLER_KEY_SECRET ?? '', 'meteoras-bundler-keys', 32)
}

function encryptSecret(plain: string): string {
  if (!isEncryptionEnabled()) return plain
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith('enc:v1:')) return stored
  const [, , ivB64, tagB64, dataB64] = stored.split(':')
  const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
