import { randomUUID } from 'node:crypto'
import { MetadataUploadRequest } from './schema'

type PinataUploadResult = {
  id?: string
  name?: string
  cid?: string
  IpfsHash?: string
  size?: number
  mime_type?: string
}

export type MetadataUploadResponse = {
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

const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files'
const MAX_IMAGE_BYTES = Number(process.env.PINATA_MAX_IMAGE_BYTES ?? 8 * 1024 * 1024)

export async function createPinataMetadataUpload(request: MetadataUploadRequest): Promise<MetadataUploadResponse> {
  const config = readPinataConfig(request)
  const image = parseImageDataUrl(request.imageDataUrl)
  if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Token art is too large. Maximum image size is ${formatBytes(MAX_IMAGE_BYTES)}.`)
  }

  const imageName = sanitizeFileName(request.imageName || `${request.tokenSymbol}-token-art`)
  const imageUpload = await uploadFileToPinata({
    jwt: config.jwt,
    bytes: image.bytes,
    fileName: imageName,
    mimeType: image.mimeType,
  })
  const imageCid = getUploadCid(imageUpload)
  const imageUri = buildGatewayUrl(config.gateway, imageCid)
  const metadata = buildTokenMetadata(request, imageUri)
  const metadataName = sanitizeFileName(`${request.tokenSymbol || 'token'}-metadata-${randomUUID().slice(0, 8)}.json`)
  const metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2), 'utf8')
  const metadataUpload = await uploadFileToPinata({
    jwt: config.jwt,
    bytes: metadataBytes,
    fileName: metadataName,
    mimeType: 'application/json',
  })
  const metadataCid = getUploadCid(metadataUpload)

  return {
    metadataUri: buildGatewayUrl(config.gateway, metadataCid),
    imageUri,
    metadata,
    uploads: {
      image: {
        cid: imageCid,
        name: imageUpload.name || imageName,
      },
      metadata: {
        cid: metadataCid,
        name: metadataUpload.name || metadataName,
      },
    },
  }
}

function readPinataConfig(request: MetadataUploadRequest) {
  const jwt = request.pinataJwt?.trim() || process.env.PINATA_JWT?.trim()
  if (!jwt) {
    throw new Error('Pinata JWT is required. Paste a one-time JWT in the app or configure PINATA_JWT on the API server.')
  }

  return {
    jwt,
    gateway: normalizeGateway(
      request.pinataGateway || process.env.PINATA_GATEWAY || process.env.PINATA_GATEWAY_DOMAIN || 'gateway.pinata.cloud',
    ),
  }
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i)
  if (!match) {
    throw new Error('Token art must be a base64 image data URL.')
  }

  return {
    mimeType: match[1].toLowerCase(),
    bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
  }
}

async function uploadFileToPinata({
  jwt,
  bytes,
  fileName,
  mimeType,
}: {
  jwt: string
  bytes: Buffer
  fileName: string
  mimeType: string
}): Promise<PinataUploadResult> {
  const formData = new FormData()
  const arrayBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(arrayBuffer).set(bytes)
  formData.append('file', new Blob([arrayBuffer], { type: mimeType }), fileName)

  const response = await fetch(PINATA_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: formData,
  })

  const body = await readPinataResponse(response)
  if (!response.ok) {
    throw new Error(getPinataError(body, response.statusText))
  }

  if (!isRecord(body)) {
    throw new Error('Pinata returned an invalid upload response.')
  }

  return body as PinataUploadResult
}

async function readPinataResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function getPinataError(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    if (typeof body.error === 'string') return body.error
    if (typeof body.message === 'string') return body.message
  }

  return fallback || 'Pinata upload failed.'
}

function getUploadCid(upload: PinataUploadResult): string {
  const cid = upload.cid || upload.IpfsHash
  if (!cid) {
    throw new Error('Pinata upload succeeded but did not return a CID.')
  }

  return cid
}

function buildTokenMetadata(request: MetadataUploadRequest, imageUri: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    name: request.tokenName.trim(),
    symbol: request.tokenSymbol.trim().toUpperCase(),
    description: request.description.trim(),
    image: imageUri,
  }
  const website = request.website.trim()
  const xHandle = request.xHandle.trim()
  const extensions: Record<string, string> = {}

  if (website) {
    metadata.external_url = website
    extensions.website = website
  }
  if (xHandle) {
    extensions.twitter = normalizeXHandle(xHandle)
  }
  if (request.wallet?.trim()) {
    metadata.properties = {
      creator_wallet: request.wallet.trim(),
      files: [
        {
          uri: imageUri,
          type: getImageMimeTypeFromDataUrl(request.imageDataUrl),
        },
      ],
    }
  }
  if (Object.keys(extensions).length) {
    metadata.extensions = extensions
  }

  return metadata
}

function getImageMimeTypeFromDataUrl(dataUrl: string): string {
  return dataUrl.match(/^data:([^;,]+)/i)?.[1].toLowerCase() ?? 'image/png'
}

function normalizeXHandle(value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `https://x.com/${value.replace(/^@/, '')}`
}

function buildGatewayUrl(gateway: string, cid: string): string {
  return `https://${gateway}/ipfs/${cid}`
}

function normalizeGateway(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)

  return sanitized || `upload-${randomUUID().slice(0, 8)}`
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
