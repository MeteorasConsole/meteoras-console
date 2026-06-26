import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import {
  buildLeftoverRoute,
  createCreatorFeeClaimDryRun,
  createMeteoraDryRun,
  executeCreatorFeeClaim,
  executeSignedLaunch,
  listWalletLaunches,
} from './meteora'
import {
  creatorFeeDryRunRequestSchema,
  dryRunLaunchRequestSchema,
  executeCreatorFeeClaimRequestSchema,
  executeLaunchRequestSchema,
  leftoverRouteRequestSchema,
  metadataUploadRequestSchema,
} from './schema'
import { createPinataMetadataUpload } from './pinata'
import { createBundlerDryRun, executeBundler, exportBundleKeys } from './bundler'
import { bundlerDryRunRequestSchema, executeBundlerRequestSchema } from './schema'

const port = Number(process.env.PORT ?? 8787)
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000)
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 120)
const metadataUploadBodyLimitBytes = Number(process.env.METADATA_UPLOAD_BODY_LIMIT_BYTES ?? 12_000_000)
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

class RequestBodyTooLargeError extends Error {
  statusCode = 413
}

const server = createServer(async (request, response) => {
  try {
    setCorsHeaders(request, response)

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'meteoras-console-api' })
      return
    }

    if (!checkRateLimit(request)) {
      sendJson(response, 429, { error: 'Too many requests. Try again shortly.' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/launches') {
      const wallet = url.searchParams.get('wallet')?.trim() ?? ''
      if (wallet.length < 32) {
        sendJson(response, 400, { error: 'wallet query parameter is required.' })
        return
      }

      const launches = await listWalletLaunches(wallet)
      sendJson(response, 200, { launches })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/metadata/pinata') {
      const body = await readJsonBody(request, metadataUploadBodyLimitBytes)
      const parsed = metadataUploadRequestSchema.safeParse(body)
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid metadata upload request.', issues: parsed.error.issues })
        return
      }

      const result = await createPinataMetadataUpload(parsed.data)
      sendJson(response, 200, result)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/launches/dry-run') {
      const body = await readJsonBody(request)
      const parsed = dryRunLaunchRequestSchema.safeParse(body)
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid dry-run request.', issues: parsed.error.issues })
        return
      }

      const result = await createMeteoraDryRun(parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/creator-fees/dry-run') {
      const body = await readJsonBody(request)
      const parsed = creatorFeeDryRunRequestSchema.safeParse(body)
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid creator fee dry-run request.', issues: parsed.error.issues })
        return
      }

      const result = await createCreatorFeeClaimDryRun(parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/bundler/dry-run') {
      const body = await readJsonBody(request)
      const parsed = bundlerDryRunRequestSchema.safeParse(body)
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid bundler dry-run request.', issues: parsed.error.issues })
        return
      }

      const result = await createBundlerDryRun(parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    const bundlerExecuteMatch = url.pathname.match(/^\/api\/bundler\/([^/]+)\/execute$/)
    if (request.method === 'POST' && bundlerExecuteMatch) {
      const body = await readJsonBody(request)
      const parsed = executeBundlerRequestSchema.safeParse({
        ...(isRecord(body) ? body : {}),
        bundleId: bundlerExecuteMatch[1],
      })
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid bundler execute request.', issues: parsed.error.issues })
        return
      }

      const result = await executeBundler(parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    const bundlerKeysMatch = url.pathname.match(/^\/api\/bundler\/([^/]+)\/keys$/)
    if (request.method === 'GET' && bundlerKeysMatch) {
      const result = await exportBundleKeys(bundlerKeysMatch[1])
      if (!result) {
        sendJson(response, 404, { error: 'Unknown bundle id.' })
        return
      }

      sendJson(response, 200, result)
      return
    }

    const creatorFeeExecuteMatch = url.pathname.match(/^\/api\/creator-fees\/([^/]+)\/execute$/)
    if (request.method === 'POST' && creatorFeeExecuteMatch) {
      const body = await readJsonBody(request)
      const parsed = executeCreatorFeeClaimRequestSchema.safeParse({
        ...(isRecord(body) ? body : {}),
        claimId: creatorFeeExecuteMatch[1],
      })
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid creator fee execute request.', issues: parsed.error.issues })
        return
      }

      const result = await executeCreatorFeeClaim(parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    const executeMatch = url.pathname.match(/^\/api\/launches\/([^/]+)\/execute$/)
    if (request.method === 'POST' && executeMatch) {
      const body = await readJsonBody(request)
      const parsed = executeLaunchRequestSchema.safeParse({
        ...(isRecord(body) ? body : {}),
        dryRunId: executeMatch[1],
      })
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid execute request.', issues: parsed.error.issues })
        return
      }

      const result = await executeSignedLaunch(parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    const routeMatch = url.pathname.match(/^\/api\/launches\/([^/]+)\/leftover-route$/)
    if (request.method === 'POST' && routeMatch) {
      const body = await readJsonBody(request)
      const parsed = leftoverRouteRequestSchema.safeParse(body)
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid leftover route request.', issues: parsed.error.issues })
        return
      }

      const result = await buildLeftoverRoute(routeMatch[1], parsed.data)
      sendJson(response, result.status === 'blocked' ? 409 : 200, result)
      return
    }

    sendJson(response, 404, { error: 'Not found.' })
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, error.statusCode, { error: error.message })
      return
    }

    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Internal server error.',
    })
  }
})

server.listen(port, () => {
  console.log(`meteoras-console-api listening on http://127.0.0.1:${port}`)
})

async function readJsonBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError(`Request body is too large. Maximum size is ${maxBytes} bytes.`)
    }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}

  return JSON.parse(text)
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
  })
  response.end(JSON.stringify(body, null, 2))
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse) {
  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  const requestOrigin = request.headers.origin
  const origin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0]

  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Vary', 'Origin')
}

function checkRateLimit(request: IncomingMessage): boolean {
  if (rateLimitMax <= 0) return true

  const now = Date.now()
  const key = getClientKey(request)
  const current = rateLimitBuckets.get(key)
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs })
    return true
  }

  current.count += 1
  return current.count <= rateLimitMax
}

function getClientKey(request: IncomingMessage): string {
  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }

  return request.socket.remoteAddress ?? 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
