import { createHash, randomUUID } from 'node:crypto'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithLiquidityWeights,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT } from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  CreatorFeeDryRunRequest,
  DryRunLaunchRequest,
  ExecuteCreatorFeeClaimRequest,
  ExecuteLaunchRequest,
  LeftoverRouteRequest,
} from './schema'
import { loadPersistedState, persistPartialState } from './stateStore'

const DEFAULT_MAINNET_USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const DRY_RUN_TTL_MS = 90_000

type PreparedTransaction = {
  name: string
  base64: string
  requiredSigners: string[]
  signedByServer: string[]
}

type StoredLaunch = {
  launchId: string
  payloadHash: string
  createdAt: number
  submittedAt?: number
  blockhash: string
  lastValidBlockHeight: number
  pool: string
  config: string
  baseMint: string
  tokenName?: string
  tokenSymbol?: string
  quoteAsset?: 'SOL' | 'USDC'
  metadataUri?: string
  poolCreator?: string
  feeClaimer?: string
  signatures?: string[]
  requiredSigners: string[]
  transactions: PreparedTransaction[]
}

type StoredCreatorFeeClaim = {
  claimId: string
  payloadHash: string
  createdAt: number
  blockhash: string
  lastValidBlockHeight: number
  pool: string
  creator: string
  receiver: string
  transactions: PreparedTransaction[]
}

type SimulationStep = {
  name: string
  ok: boolean
  err: unknown
  logs: string[]
  unitsConsumed?: number
}

type StateFile = {
  launches?: StoredLaunch[]
  creatorFeeClaims?: StoredCreatorFeeClaim[]
}

export type WalletLaunchListItem = {
  launchId: string
  pool: string
  config: string
  baseMint: string
  tokenName: string
  tokenSymbol: string
  quoteAsset: 'SOL' | 'USDC' | 'Unknown'
  createdAt: number
  submittedAt?: number
  status: 'prepared' | 'submitted'
  signatures: string[]
}

const launches = new Map<string, StoredLaunch>()
const creatorFeeClaims = new Map<string, StoredCreatorFeeClaim>()
let stateLoaded = false

export async function createMeteoraDryRun(request: DryRunLaunchRequest) {
  await ensureStateLoaded()
  const env = readLaunchEnv(request)
  const connection = new Connection(env.rpcUrl, 'confirmed')
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const config = Keypair.generate()
  const baseMint = Keypair.generate()
  const quoteMint = getQuoteMint(request.payload.args.curve.quoteAsset)
  const configParams = buildMeteoraConfig(request)
  const metadataUri = request.payload.args.token.metadataUri ?? env.defaultMetadataUri

  if (!metadataUri) {
    return {
      launchId: randomUUID(),
      status: 'blocked' as const,
      payloadHash: hashJson(request.payload),
      payload: request.payload,
      transactions: [],
      simulation: {
        ok: false,
        logs: [],
        warnings: ['Metadata upload is not implemented yet. Upload token metadata JSON to Pinata/IPFS and provide the public gateway URL before preparing mainnet launch transactions.'],
      },
      error: 'Metadata URI is required before launch transaction building. Paste the public metadata JSON gateway URL and retry.',
    }
  }

  if (request.payload.args.curve.optionalSeedBuy > 0) {
    return {
      launchId: randomUUID(),
      status: 'blocked' as const,
      payloadHash: hashJson(request.payload),
      payload: request.payload,
      transactions: [],
      simulation: {
        ok: false,
        logs: [],
        warnings: ['Optional first buy requires minimum-out quote and slippage controls before it can be safely included.'],
      },
      error: 'Optional first buy is not included in generated launch transactions yet.',
    }
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const createTransactions = await client.partner.createConfigAndPoolWithFirstBuy({
    ...configParams,
    config: config.publicKey,
    feeClaimer: env.feeClaimer,
    leftoverReceiver: new PublicKey(request.payload.args.leftoverRouting.leftoverReceiver),
    payer: env.payer,
    quoteMint,
    preCreatePoolParam: {
      name: request.payload.args.token.name,
      symbol: request.payload.args.token.symbol,
      uri: metadataUri,
      poolCreator: env.poolCreator,
      baseMint: baseMint.publicKey,
    },
  })

  const txs = [
    ['createConfig', createTransactions.createConfigTx, [config]],
    ['createPool', createTransactions.createPoolWithFirstBuyTx, [baseMint]],
  ] as const

  const transactions = txs.map(([name, tx, signers]) => prepareTransaction(name, tx, env.payer, blockhash, signers))
  const simulation = await simulatePreparedTransactions(connection, transactions)
  const warnings = getDryRunWarnings(request)
  const pool = deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey)
  const payloadHash = hashJson(request.payload)
  const requiredSigners = Array.from(
    new Set([
      env.payer.toBase58(),
      env.feeClaimer.toBase58(),
      env.poolCreator.toBase58(),
      config.publicKey.toBase58(),
      baseMint.publicKey.toBase58(),
      ...transactions.flatMap((tx) => tx.requiredSigners),
    ]),
  )
  const launchId = randomUUID()

  launches.set(launchId, {
    launchId,
    payloadHash,
    createdAt: Date.now(),
    blockhash,
    lastValidBlockHeight,
    pool: pool.toBase58(),
    config: config.publicKey.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
    tokenName: request.payload.args.token.name,
    tokenSymbol: request.payload.args.token.symbol,
    quoteAsset: request.payload.args.curve.quoteAsset,
    metadataUri,
    poolCreator: env.poolCreator.toBase58(),
    feeClaimer: env.feeClaimer.toBase58(),
    requiredSigners,
    transactions,
  })
  await persistState()

  return {
    launchId,
    status: simulation.ok ? 'simulated' as const : 'blocked' as const,
    payloadHash,
    payload: request.payload,
    accounts: {
      pool: pool.toBase58(),
      config: config.publicKey.toBase58(),
      baseMint: baseMint.publicKey.toBase58(),
      quoteMint: quoteMint.toBase58(),
      payer: env.payer.toBase58(),
      feeClaimer: env.feeClaimer.toBase58(),
      poolCreator: env.poolCreator.toBase58(),
      leftoverReceiver: request.payload.args.leftoverRouting.leftoverReceiver,
    },
    normalizedConfig: {
      migrationOption: 'MET_DAMM_V2',
      liquidityDistribution: '100% partner permanent locked liquidity',
      tokenAuthorityOption: 'Immutable',
      poolShapeWeights: getPoolShapeWeights(request.payload.args.curve.poolShape),
      optionalSeedBuyIncluded: false,
    },
    transactions,
    simulation: {
      ok: simulation.ok,
      requiredSigners,
      logs: simulation.logs,
      warnings,
      steps: simulation.steps,
    },
    metadata: {
      uri: metadataUri,
    },
  }
}

export async function executeSignedLaunch(request: ExecuteLaunchRequest) {
  await ensureStateLoaded()
  const stored = launches.get(request.dryRunId)
  if (!stored) {
    return {
      launchId: request.dryRunId,
      status: 'blocked' as const,
      error: 'Unknown dry-run id. Run /api/launches/dry-run again.',
    }
  }

  if (request.approvedPayloadHash !== stored.payloadHash) {
    return {
      launchId: stored.launchId,
      status: 'blocked' as const,
      error: 'Approved payload hash does not match the latest dry-run.',
    }
  }

  if (isExpired(stored.createdAt)) {
    return {
      launchId: stored.launchId,
      status: 'blocked' as const,
      error: 'Dry-run transaction blockhash is stale. Run Launch token again to prepare fresh transactions.',
    }
  }

  if (!stored.requiredSigners.includes(request.signerWallet)) {
    return {
      launchId: stored.launchId,
      status: 'blocked' as const,
      error: 'Signer wallet is not one of the required launch signers.',
    }
  }

  if (process.env.ALLOW_MAINNET_EXECUTE !== 'true') {
    return {
      launchId: stored.launchId,
      status: 'blocked' as const,
      error: 'Transaction submission is disabled. Set ALLOW_MAINNET_EXECUTE=true only after production execution is explicitly approved.',
    }
  }

  if (!request.signedTransactionsBase64?.length) {
    return {
      launchId: stored.launchId,
      status: 'blocked' as const,
      error: 'Signed transactions are required for execution.',
    }
  }

  if (request.signedTransactionsBase64.length !== stored.transactions.length) {
    return {
      launchId: stored.launchId,
      status: 'blocked' as const,
      error: 'Signed transaction count does not match the prepared launch transaction count.',
    }
  }

  const env = readRuntimeEnv()
  const connection = new Connection(env.rpcUrl, 'confirmed')
  const signatures: string[] = []

  for (const encoded of request.signedTransactionsBase64) {
    const signature = await connection.sendRawTransaction(Buffer.from(encoded, 'base64'), {
      skipPreflight: false,
    })
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: stored.blockhash,
      lastValidBlockHeight: stored.lastValidBlockHeight,
    }, 'confirmed')
    if (confirmation.value.err) {
      return {
        launchId: stored.launchId,
        status: 'blocked' as const,
        signatures,
        error: `Launch transaction failed confirmation: ${JSON.stringify(confirmation.value.err)}`,
      }
    }
    signatures.push(signature)
  }

  stored.signatures = signatures
  stored.submittedAt = Date.now()
  await persistState()

  return {
    launchId: stored.launchId,
    status: 'submitted' as const,
    signatures,
  }
}

export async function listWalletLaunches(walletAddress: string): Promise<WalletLaunchListItem[]> {
  await ensureStateLoaded()

  return Array.from(launches.values())
    .filter((launch) => launchMatchesWallet(launch, walletAddress))
    .sort((a, b) => (b.submittedAt ?? b.createdAt) - (a.submittedAt ?? a.createdAt))
    .map((launch) => ({
      launchId: launch.launchId,
      pool: launch.pool,
      config: launch.config,
      baseMint: launch.baseMint,
      tokenName: launch.tokenName ?? 'Untitled token',
      tokenSymbol: launch.tokenSymbol ?? 'TOKEN',
      quoteAsset: launch.quoteAsset ?? 'Unknown',
      createdAt: launch.createdAt,
      submittedAt: launch.submittedAt,
      status: launch.submittedAt ? 'submitted' as const : 'prepared' as const,
      signatures: launch.signatures ?? [],
    }))
}

export async function createCreatorFeeClaimDryRun(request: CreatorFeeDryRunRequest) {
  await ensureStateLoaded()
  const env = readRuntimeEnv()
  const connection = new Connection(env.rpcUrl, 'confirmed')
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const pool = new PublicKey(request.poolAddress)
  const creator = new PublicKey(request.creatorWallet)
  const receiver = new PublicKey(request.receiverWallet)
  const feeBreakdown = await client.state.getPoolFeeBreakdown(pool)
  const totalUnclaimed = feeBreakdown.creator.unclaimedBaseFee.add(feeBreakdown.creator.unclaimedQuoteFee)

  if (totalUnclaimed.isZero()) {
    return {
      claimId: randomUUID(),
      status: 'blocked' as const,
      pool: pool.toBase58(),
      creator: creator.toBase58(),
      receiver: receiver.toBase58(),
      fees: serializeCreatorFees(feeBreakdown.creator),
      error: 'No unclaimed creator trading fees were found for this pool.',
    }
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const tx = await client.creator.claimCreatorTradingFeeToReceiver({
    creator,
    payer: creator,
    pool,
    maxBaseAmount: feeBreakdown.creator.unclaimedBaseFee,
    maxQuoteAmount: feeBreakdown.creator.unclaimedQuoteFee,
    receiver,
  })
  const transaction = prepareTransaction('claimCreatorTradingFee', tx, creator, blockhash)
  const simulation = await simulatePreparedTransactions(connection, [transaction])
  const payload = {
    backendFunction: 'claim_creator_pool_fees',
    pool: pool.toBase58(),
    creator: creator.toBase58(),
    receiver: receiver.toBase58(),
    maxBaseAmount: feeBreakdown.creator.unclaimedBaseFee.toString(10),
    maxQuoteAmount: feeBreakdown.creator.unclaimedQuoteFee.toString(10),
  }
  const payloadHash = hashJson(payload)
  const claimId = randomUUID()

  creatorFeeClaims.set(claimId, {
    claimId,
    payloadHash,
    createdAt: Date.now(),
    blockhash,
    lastValidBlockHeight,
    pool: pool.toBase58(),
    creator: creator.toBase58(),
    receiver: receiver.toBase58(),
    transactions: [transaction],
  })
  await persistState()

  return {
    claimId,
    status: simulation.ok ? 'prepared' as const : 'blocked' as const,
    payloadHash,
    pool: pool.toBase58(),
    creator: creator.toBase58(),
    receiver: receiver.toBase58(),
    fees: serializeCreatorFees(feeBreakdown.creator),
    transactions: [transaction],
    simulation,
    error: simulation.ok ? undefined : 'Creator fee claim simulation failed. Check the pool, creator wallet, and receiver.',
    warnings: [
      'This prepares a creator trading-fee claim for wallet approval. Transaction submission stays guarded by ALLOW_MAINNET_EXECUTE.',
    ],
  }
}

export async function executeCreatorFeeClaim(request: ExecuteCreatorFeeClaimRequest) {
  await ensureStateLoaded()
  const stored = creatorFeeClaims.get(request.claimId)
  if (!stored) {
    return {
      claimId: request.claimId,
      status: 'blocked' as const,
      error: 'Unknown creator fee claim id. Run /api/creator-fees/dry-run again.',
    }
  }

  if (request.approvedPayloadHash !== stored.payloadHash) {
    return {
      claimId: stored.claimId,
      status: 'blocked' as const,
      error: 'Approved payload hash does not match the latest fee-claim dry-run.',
    }
  }

  if (request.signerWallet !== stored.creator) {
    return {
      claimId: stored.claimId,
      status: 'blocked' as const,
      error: 'Creator fee claims must be signed by the creator wallet used in the dry-run.',
    }
  }

  if (isExpired(stored.createdAt)) {
    return {
      claimId: stored.claimId,
      status: 'blocked' as const,
      error: 'Fee claim transaction blockhash is stale. Prepare the claim again for fresh transactions.',
    }
  }

  if (process.env.ALLOW_MAINNET_EXECUTE !== 'true') {
    return {
      claimId: stored.claimId,
      status: 'blocked' as const,
      error: 'Transaction submission is disabled. Set ALLOW_MAINNET_EXECUTE=true only after production execution is explicitly approved.',
    }
  }

  if (!request.signedTransactionsBase64?.length) {
    return {
      claimId: stored.claimId,
      status: 'blocked' as const,
      error: 'Signed transactions are required for execution.',
    }
  }

  if (request.signedTransactionsBase64.length !== stored.transactions.length) {
    return {
      claimId: stored.claimId,
      status: 'blocked' as const,
      error: 'Signed transaction count does not match the prepared fee claim transaction count.',
    }
  }

  const env = readRuntimeEnv()
  const connection = new Connection(env.rpcUrl, 'confirmed')
  const signatures: string[] = []

  for (const encoded of request.signedTransactionsBase64) {
    const signature = await connection.sendRawTransaction(Buffer.from(encoded, 'base64'), {
      skipPreflight: false,
    })
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: stored.blockhash,
      lastValidBlockHeight: stored.lastValidBlockHeight,
    }, 'confirmed')
    if (confirmation.value.err) {
      return {
        claimId: stored.claimId,
        status: 'blocked' as const,
        signatures,
        error: `Fee claim transaction failed confirmation: ${JSON.stringify(confirmation.value.err)}`,
      }
    }
    signatures.push(signature)
  }

  return {
    claimId: stored.claimId,
    status: 'submitted' as const,
    signatures,
  }
}

export async function buildLeftoverRoute(launchId: string, request: LeftoverRouteRequest) {
  await ensureStateLoaded()
  const stored = launches.get(launchId)
  if (!stored) {
    return {
      launchId,
      status: 'blocked' as const,
      steps: [
        {
          name: 'withdrawLeftover',
          status: 'blocked' as const,
          error: 'Unknown launch id. Run /api/launches/dry-run again.',
        },
      ],
    }
  }

  const env = readRuntimeEnv()
  const payer = new PublicKey(request.receiverWallet)
  if (request.receiverWallet.length < 32) {
    return {
      launchId,
      status: 'blocked' as const,
      steps: [
        {
          name: 'withdrawLeftover',
          status: 'blocked' as const,
          error: 'Invalid receiver wallet.',
        },
      ],
    }
  }

  const connection = new Connection(env.rpcUrl, 'confirmed')
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const { blockhash } = await connection.getLatestBlockhash()
  const tx = await client.migration.withdrawLeftover({
    payer,
    pool: new PublicKey(stored.pool),
  })
  const transaction = prepareTransaction('withdrawLeftover', tx, payer, blockhash)

  return {
    launchId,
    status: 'queued' as const,
    steps: [
      {
        name: 'withdrawLeftover',
        status: 'pending' as const,
        transaction,
      },
    ],
  }
}

async function simulatePreparedTransactions(connection: Connection, transactions: PreparedTransaction[]) {
  const steps: SimulationStep[] = []

  for (const transaction of transactions) {
    try {
      const tx = Transaction.from(Buffer.from(transaction.base64, 'base64'))
      const result = await connection.simulateTransaction(tx)
      steps.push({
        name: transaction.name,
        ok: !result.value.err,
        err: result.value.err ?? null,
        logs: result.value.logs ?? [],
        unitsConsumed: result.value.unitsConsumed ?? undefined,
      })
    } catch (error) {
      steps.push({
        name: transaction.name,
        ok: false,
        err: error instanceof Error ? error.message : String(error),
        logs: [],
      })
    }
  }

  return {
    ok: steps.every((step) => step.ok),
    logs: steps.flatMap((step) => step.logs),
    steps,
  }
}

async function ensureStateLoaded() {
  if (stateLoaded) return
  stateLoaded = true

  try {
    const state = await loadPersistedState() as StateFile
    for (const launch of state.launches ?? []) {
      launches.set(launch.launchId, launch)
    }
    for (const claim of state.creatorFeeClaims ?? []) {
      creatorFeeClaims.set(claim.claimId, claim)
    }
  } catch (error) {
    console.warn('[meteoras-console-api] failed to load persisted state', error)
  }
}

async function persistState() {
  await persistPartialState({
    launches: Array.from(launches.values()),
    creatorFeeClaims: Array.from(creatorFeeClaims.values()),
  })
}

function isExpired(createdAt: number): boolean {
  return Date.now() - createdAt > DRY_RUN_TTL_MS
}

function launchMatchesWallet(launch: StoredLaunch, walletAddress: string): boolean {
  return launch.poolCreator === walletAddress
    || launch.feeClaimer === walletAddress
    || launch.requiredSigners.includes(walletAddress)
}

function buildMeteoraConfig(request: DryRunLaunchRequest) {
  const curve = request.payload.args.curve
  const plan = request.clientPlan

  return buildCurveWithLiquidityWeights({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: getTokenDecimal(curve.tokenDecimals),
      tokenQuoteDecimal: getQuoteTokenDecimal(curve.quoteAsset),
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: curve.totalSupply,
      leftover: plan.leftoverTokens,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: curve.feeBps,
          endingFeeBps: curve.feeBps,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: Math.max(25, Math.min(1000, curve.feeBps)),
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: curve.initialMarketCap,
    migrationMarketCap: curve.migrationMarketCap,
    liquidityWeights: getPoolShapeWeights(curve.poolShape),
  })
}

function getPoolShapeWeights(poolShape: 'linear' | 'exponential'): number[] {
  if (poolShape === 'linear') return Array.from({ length: 16 }, () => 1)

  // Higher early liquidity and lower late liquidity makes price movement accelerate toward migration.
  return [16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2.5, 2, 1.6, 1.3, 1.1, 1]
}

function getTokenDecimal(decimals: 6 | 7 | 8 | 9): TokenDecimal {
  if (decimals === 6) return TokenDecimal.SIX
  if (decimals === 7) return TokenDecimal.SEVEN
  if (decimals === 8) return TokenDecimal.EIGHT
  return TokenDecimal.NINE
}

function getQuoteTokenDecimal(quoteAsset: 'SOL' | 'USDC'): TokenDecimal {
  return quoteAsset === 'SOL' ? TokenDecimal.NINE : TokenDecimal.SIX
}

function getQuoteMint(quoteAsset: 'SOL' | 'USDC'): PublicKey {
  if (quoteAsset === 'SOL') {
    return process.env.QUOTE_MINT_SOL ? new PublicKey(process.env.QUOTE_MINT_SOL) : NATIVE_MINT
  }

  return process.env.QUOTE_MINT_USDC ? new PublicKey(process.env.QUOTE_MINT_USDC) : DEFAULT_MAINNET_USDC
}

function prepareTransaction(
  name: string,
  tx: Transaction,
  feePayer: PublicKey,
  blockhash: string,
  partialSigners: readonly Keypair[] = [],
): PreparedTransaction {
  tx.feePayer = feePayer
  tx.recentBlockhash = blockhash
  if (partialSigners.length > 0) {
    tx.partialSign(...partialSigners)
  }

  return {
    name,
    base64: Buffer.from(
      tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
    ).toString('base64'),
    requiredSigners: getRequiredSigners(tx),
    signedByServer: partialSigners.map((signer) => signer.publicKey.toBase58()),
  }
}

function getRequiredSigners(tx: Transaction): string[] {
  const message = tx.compileMessage()
  return message.accountKeys
    .filter((_, index) => message.isAccountSigner(index))
    .map((key) => key.toBase58())
}

function getDryRunWarnings(request: DryRunLaunchRequest): string[] {
  const warnings = request.clientPlan.validationIssues
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => issue.message)

  if (!request.payload.args.token.metadataUri) {
    warnings.push('No metadata URI was provided; DEFAULT_TOKEN_METADATA_URI was used as the public metadata JSON URL.')
  }
  if (request.payload.args.curve.optionalSeedBuy > 0) {
    warnings.push('Optional first buy is modeled but not included in generated unsigned transactions yet.')
  }

  return warnings
}

function serializeCreatorFees(fees: {
  unclaimedBaseFee: { toString: (radix?: number) => string }
  unclaimedQuoteFee: { toString: (radix?: number) => string }
  claimedBaseFee: { toString: (radix?: number) => string }
  claimedQuoteFee: { toString: (radix?: number) => string }
}) {
  return {
    unclaimedBaseFee: fees.unclaimedBaseFee.toString(10),
    unclaimedQuoteFee: fees.unclaimedQuoteFee.toString(10),
    claimedBaseFee: fees.claimedBaseFee.toString(10),
    claimedQuoteFee: fees.claimedQuoteFee.toString(10),
  }
}

function readRuntimeEnv() {
  return {
    rpcUrl: process.env.RPC_URL ?? 'https://api.devnet.solana.com',
    defaultMetadataUri: process.env.DEFAULT_TOKEN_METADATA_URI || null,
  }
}

function readLaunchEnv(request: DryRunLaunchRequest) {
  const wallet = request.wallet?.publicKey ? new PublicKey(request.wallet.publicKey) : null

  return {
    ...readRuntimeEnv(),
    payer: wallet ?? readPublicKey('LAUNCH_PAYER_PUBLIC_KEY'),
    feeClaimer: wallet ?? readPublicKey('LAUNCH_FEE_CLAIMER_PUBLIC_KEY'),
    poolCreator: wallet ?? readPublicKey('LAUNCH_POOL_CREATOR_PUBLIC_KEY'),
  }
}

function readPublicKey(name: string): PublicKey {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required for Meteora DBC transaction building.`)
  }

  return new PublicKey(value)
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
