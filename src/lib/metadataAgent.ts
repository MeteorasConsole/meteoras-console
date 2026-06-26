import { LaunchForm } from './launchpad'

export type PinataMetadataUploadResponse = {
  metadataUri: string
  imageUri: string
  metadata: Record<string, unknown>
  uploads: {
    image: {
      cid: string
      name: string
    }
    metadata: {
      cid: string
      name: string
    }
  }
}

export type PinataMetadataCredentials = {
  jwt: string
  gateway: string
}

export class MetadataAgentError extends Error {
  status: number
  details: unknown

  constructor(message: string, status: number, details: unknown) {
    super(message)
    this.name = 'MetadataAgentError'
    this.status = status
    this.details = details
  }
}

const launchApiBaseUrl = import.meta.env.VITE_LAUNCH_API_BASE_URL?.replace(/\/$/, '') ?? ''

export async function uploadMetadataWithPinataAgent(
  form: LaunchForm,
  credentials: PinataMetadataCredentials,
  wallet?: string,
): Promise<PinataMetadataUploadResponse> {
  if (!launchApiBaseUrl) {
    throw new MetadataAgentError('Launch API is not configured.', 0, null)
  }
  if (!form.imagePreview || !form.imageName) {
    throw new MetadataAgentError('Add token art before running the Pinata metadata agent.', 0, null)
  }

  const response = await fetch(`${launchApiBaseUrl}/api/metadata/pinata`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      wallet: wallet || undefined,
      tokenName: form.tokenName,
      tokenSymbol: form.tokenSymbol,
      description: form.description,
      website: form.website,
      xHandle: form.xHandle,
      imageName: form.imageName,
      imageDataUrl: form.imagePreview,
      pinataJwt: credentials.jwt.trim() || undefined,
      pinataGateway: credentials.gateway.trim() || undefined,
    }),
  })

  const body = await readJson(response)
  if (!response.ok) {
    throw new MetadataAgentError(getErrorMessage(body, response.statusText), response.status, body)
  }

  return body as PinataMetadataUploadResponse
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

  return fallback || 'Metadata agent request failed.'
}
