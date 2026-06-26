import { LaunchForm, ValidationIssue, buildExecutionPayload, buildLaunchPlan } from './launchpad'

export type LaunchExecutionPayload = ReturnType<typeof buildExecutionPayload>

export type DryRunLaunchRequest = {
  wallet?: {
    publicKey: string
  }
  payload: LaunchExecutionPayload
  clientPlan: {
    totalSupply: number
    publicFloatTokens: number
    leftoverTokens: number
    leftoverPercent: number
    teamPercent: number
    initialPrice: number
    validationIssues: ValidationIssue[]
  }
}

export type DryRunLaunchResponse = {
  launchId: string
  status: 'simulated' | 'blocked'
  payloadHash?: string
  payload: LaunchExecutionPayload
  error?: string
  accounts?: Record<string, string>
  normalizedConfig?: Record<string, unknown>
  transactions?: Array<{
    name: string
    base64: string
    requiredSigners: string[]
    signedByServer?: string[]
  }>
  simulation: {
    ok: boolean
    logs?: string[]
    warnings?: string[]
    transactionBase64?: string
    requiredSigners?: string[]
    steps?: Array<{
      name: string
      ok: boolean
      err: unknown
      logs: string[]
      unitsConsumed?: number
    }>
  }
  metadata?: {
    uri?: string
    imageUri?: string
  }
}

export type ExecuteLaunchResponse = {
  launchId: string
  status: 'submitted' | 'confirmed' | 'blocked'
  signatures?: string[]
  signature?: string
  explorerUrl?: string
  error?: string
}

export class LaunchApiError extends Error {
  status: number
  details: unknown

  constructor(message: string, status: number, details: unknown) {
    super(message)
    this.name = 'LaunchApiError'
    this.status = status
    this.details = details
  }
}

const launchApiBaseUrl = import.meta.env.VITE_LAUNCH_API_BASE_URL?.replace(/\/$/, '') ?? ''

export function isLaunchApiConfigured(): boolean {
  return launchApiBaseUrl.length > 0
}

export function getLaunchApiMode(): 'api' | 'local' {
  return isLaunchApiConfigured() ? 'api' : 'local'
}

export async function createDryRunLaunch(form: LaunchForm, walletPublicKey?: string): Promise<DryRunLaunchResponse> {
  if (!launchApiBaseUrl) {
    throw new LaunchApiError('Launch API is not configured.', 0, null)
  }

  const request = buildDryRunLaunchRequest(form, walletPublicKey)
  const response = await fetch(`${launchApiBaseUrl}/api/launches/dry-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  const body = await readJson(response)
  if (!response.ok) {
    throw new LaunchApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as DryRunLaunchResponse
}

export async function executeLaunch(
  dryRunId: string,
  signerWallet: string,
  approvedPayloadHash: string,
  signedTransactionsBase64: string[],
): Promise<ExecuteLaunchResponse> {
  if (!launchApiBaseUrl) {
    throw new LaunchApiError('Launch API is not configured.', 0, null)
  }

  const response = await fetch(`${launchApiBaseUrl}/api/launches/${dryRunId}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dryRunId,
      signerWallet,
      approvedPayloadHash,
      signedTransactionsBase64,
    }),
  })

  const body = await readJson(response)
  if (response.status === 409 && isRecord(body) && body.status === 'blocked') {
    return body as ExecuteLaunchResponse
  }

  if (!response.ok) {
    throw new LaunchApiError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as ExecuteLaunchResponse
}

export function buildDryRunLaunchRequest(form: LaunchForm, walletPublicKey?: string): DryRunLaunchRequest {
  const plan = buildLaunchPlan(form)

  return {
    wallet: walletPublicKey ? { publicKey: walletPublicKey } : undefined,
    payload: buildExecutionPayload(form),
    clientPlan: {
      totalSupply: plan.totalSupply,
      publicFloatTokens: plan.publicFloatTokens,
      leftoverTokens: plan.leftoverTokens,
      leftoverPercent: plan.leftoverPercent,
      teamPercent: plan.teamPercent,
      initialPrice: plan.initialPrice,
      validationIssues: plan.validationIssues,
    },
  }
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
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error
  }

  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message
  }

  return fallback || 'Launch API request failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
