export type BundlerForm = {
  poolAddress: string
  walletCount: number
  targetSupplyPercent: number
  slippageBps: number
}

export type BundleEstimate = {
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

export type BundlerPreparedTransaction = {
  name: string
  base64: string
  requiredSigners: string[]
  signedByServer?: string[]
}

export type BundlerDryRunResponse = {
  bundleId: string
  status: 'prepared' | 'blocked'
  payloadHash?: string
  pool?: string
  fundingWallet?: string
  walletPublicKeys?: string[]
  estimate?: BundleEstimate
  fundingTransactions?: BundlerPreparedTransaction[]
  keysEncrypted?: boolean
  warnings?: string[]
  error?: string
}

export type BundlerExecuteResponse = {
  bundleId: string
  status: 'submitted' | 'blocked'
  fundingSignatures?: string[]
  buyResults?: Array<{ wallet: string; signature?: string; error?: string }>
  summary?: { wallets: number; confirmed: number; failed: number }
  error?: string
}

export type BundleKeysResponse = {
  bundleId: string
  pool: string
  fundingWallet: string
  createdAt: number
  wallets: Array<{ publicKey: string; secretKey: string }>
}

export class BundlerApiError extends Error {
  status: number
  details: unknown

  constructor(message: string, status: number, details: unknown) {
    super(message)
    this.name = 'BundlerApiError'
    this.status = status
    this.details = details
  }
}

const launchApiBaseUrl = import.meta.env.VITE_LAUNCH_API_BASE_URL?.replace(/\/$/, '') ?? ''

export async function createBundlerDryRun(form: BundlerForm, fundingWallet: string): Promise<BundlerDryRunResponse> {
  if (!launchApiBaseUrl) {
    throw new BundlerApiError('Launch API is not configured.', 0, null)
  }

  const response = await fetch(`${launchApiBaseUrl}/api/bundler/dry-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      poolAddress: form.poolAddress.trim(),
      fundingWallet,
      walletCount: form.walletCount,
      targetSupplyPercent: form.targetSupplyPercent,
      slippageBps: form.slippageBps,
    }),
  })

  const body = await readJson(response)
  if (response.status === 409 && isRecord(body) && body.status === 'blocked') {
    return body as BundlerDryRunResponse
  }
  if (!response.ok) {
    throw new BundlerApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as BundlerDryRunResponse
}

export async function executeBundler(
  bundleId: string,
  signerWallet: string,
  approvedPayloadHash: string,
  signedFundingTransactionsBase64: string[],
): Promise<BundlerExecuteResponse> {
  if (!launchApiBaseUrl) {
    throw new BundlerApiError('Launch API is not configured.', 0, null)
  }

  const response = await fetch(`${launchApiBaseUrl}/api/bundler/${bundleId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundleId, signerWallet, approvedPayloadHash, signedFundingTransactionsBase64 }),
  })

  const body = await readJson(response)
  if (response.status === 409 && isRecord(body) && body.status === 'blocked') {
    return body as BundlerExecuteResponse
  }
  if (!response.ok) {
    throw new BundlerApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as BundlerExecuteResponse
}

export async function fetchBundleKeys(bundleId: string): Promise<BundleKeysResponse> {
  if (!launchApiBaseUrl) {
    throw new BundlerApiError('Launch API is not configured.', 0, null)
  }

  const response = await fetch(`${launchApiBaseUrl}/api/bundler/${bundleId}/keys`)
  const body = await readJson(response)
  if (!response.ok) {
    throw new BundlerApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as BundleKeysResponse
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function getErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error
  return fallback || 'Bundler API request failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
