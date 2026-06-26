export type FeeClaimForm = {
  poolAddress: string
  creatorWallet: string
  receiverWallet: string
}

export type FeeClaimDryRunResponse = {
  claimId: string
  status: 'prepared' | 'blocked'
  payloadHash?: string
  pool: string
  creator: string
  receiver: string
  fees?: {
    unclaimedBaseFee: string
    unclaimedQuoteFee: string
    claimedBaseFee: string
    claimedQuoteFee: string
  }
  transactions?: Array<{
    name: string
    base64: string
    requiredSigners: string[]
    signedByServer?: string[]
  }>
  simulation?: {
    ok: boolean
    logs?: string[]
    steps?: Array<{
      name: string
      ok: boolean
      err: unknown
      logs: string[]
      unitsConsumed?: number
    }>
  }
  error?: string
  warnings?: string[]
}

export type FeeClaimExecuteResponse = {
  claimId: string
  status: 'submitted' | 'confirmed' | 'blocked'
  signatures?: string[]
  signature?: string
  error?: string
}

export type CreatorLaunchListItem = {
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

export class FeeClaimApiError extends Error {
  status: number
  details: unknown

  constructor(message: string, status: number, details: unknown) {
    super(message)
    this.name = 'FeeClaimApiError'
    this.status = status
    this.details = details
  }
}

const launchApiBaseUrl = import.meta.env.VITE_LAUNCH_API_BASE_URL?.replace(/\/$/, '') ?? ''

export async function createCreatorFeeClaimDryRun(
  form: FeeClaimForm,
  fallbackCreatorWallet: string,
): Promise<FeeClaimDryRunResponse> {
  if (!launchApiBaseUrl) {
    throw new FeeClaimApiError('Launch API is not configured.', 0, null)
  }

  const creatorWallet = form.creatorWallet.trim() || fallbackCreatorWallet
  const receiverWallet = form.receiverWallet.trim() || creatorWallet
  const response = await fetch(`${launchApiBaseUrl}/api/creator-fees/dry-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      poolAddress: form.poolAddress.trim(),
      creatorWallet,
      receiverWallet,
    }),
  })

  const body = await readJson(response)
  if (!response.ok) {
    throw new FeeClaimApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as FeeClaimDryRunResponse
}

export async function executeCreatorFeeClaim(
  claimId: string,
  signerWallet: string,
  approvedPayloadHash: string,
  signedTransactionsBase64: string[],
): Promise<FeeClaimExecuteResponse> {
  if (!launchApiBaseUrl) {
    throw new FeeClaimApiError('Launch API is not configured.', 0, null)
  }

  const response = await fetch(`${launchApiBaseUrl}/api/creator-fees/${claimId}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      claimId,
      signerWallet,
      approvedPayloadHash,
      signedTransactionsBase64,
    }),
  })

  const body = await readJson(response)
  if (response.status === 409 && isRecord(body) && body.status === 'blocked') {
    return body as FeeClaimExecuteResponse
  }

  if (!response.ok) {
    throw new FeeClaimApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as FeeClaimExecuteResponse
}

export async function listCreatorLaunches(walletAddress: string): Promise<CreatorLaunchListItem[]> {
  if (!launchApiBaseUrl) {
    throw new FeeClaimApiError('Launch API is not configured.', 0, null)
  }

  const params = new URLSearchParams({ wallet: walletAddress })
  const response = await fetch(`${launchApiBaseUrl}/api/launches?${params.toString()}`)
  const body = await readJson(response)

  if (!response.ok) {
    throw new FeeClaimApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  if (isRecord(body) && Array.isArray(body.launches)) {
    return body.launches as CreatorLaunchListItem[]
  }

  return []
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
  return fallback || 'Fee claim API request failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
