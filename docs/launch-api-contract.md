# Launch API Contract

This is the frontend/backend integration contract for Meteora's Console. The current backend uses `@meteora-ag/dynamic-bonding-curve-sdk@1.5.10` to build DBC dry-run transactions.

## Configuration

Set `VITE_LAUNCH_API_BASE_URL` to enable backend dry-runs from the browser.

If the variable is missing, the app stays in local prototype mode and only runs deterministic in-browser developer functions.

```bash
VITE_LAUNCH_API_BASE_URL=https://launch-api.example.com
```

## Shared Payload

The frontend sends the output of `buildExecutionPayload(form)` plus a lightweight client-side plan summary.

```ts
type PoolShape = 'linear' | 'exponential'
type QuoteAsset = 'SOL' | 'USDC'

type LaunchExecutionPayload = {
  mode: 'dry_run_first'
  backendFunction: 'create_meteora_dbc_launch'
  args: {
    token: {
      name: string
      symbol: string
      description: string
      website: string
      xHandle: string
      metadataUri: string | null
      imageName: string | null
    }
    curve: {
      quoteAsset: QuoteAsset
      poolShape: PoolShape
      tokenDecimals: 6 | 7 | 8 | 9
      totalSupply: number
      publicFloatPercent: number
      leftoverPercent: number
      initialMarketCap: number
      migrationMarketCap: number
      feeBps: number
      optionalSeedBuy: number
    }
    leftoverRouting: {
      leftoverReceiver: string
      developerRewardsPercent: number
      treasuryPercent: number
      teamRecipients: Array<{
        label: string
        wallet: string
        percentOfSupply: number
        vestingMonths: number
      }>
    }
    safety: {
      requiresSimulation: true
      requiresWalletSignature: true
      executeMainnet: false
    }
  }
}
```

## `POST /api/launches/dry-run`

Purpose: normalize the launch intent, upload/stage metadata if supported, build the official Meteora DBC config, and simulate before any executable transaction is exposed.

Current implementation builds `createConfig` and `createPool` transactions, partial-signs server-generated `config` and `baseMint` keypairs, then returns base64 transactions for wallet review/signing. Metadata upload is not implemented yet; pass `metadataUri` or configure `DEFAULT_TOKEN_METADATA_URI`.

Request:

```ts
type DryRunLaunchRequest = {
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
    validationIssues: Array<{
      field: string
      message: string
      severity: 'error' | 'warning'
    }>
  }
}
```

When `wallet.publicKey` is present, the current server uses that public key as the launch payer, fee claimer, and pool creator. If it is absent, the server falls back to `LAUNCH_PAYER_PUBLIC_KEY`, `LAUNCH_FEE_CLAIMER_PUBLIC_KEY`, and `LAUNCH_POOL_CREATOR_PUBLIC_KEY`.

Response:

```ts
type DryRunLaunchResponse = {
  launchId: string
  status: 'simulated' | 'blocked'
  payloadHash?: string
  payload: LaunchExecutionPayload
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
  }
  metadata?: {
    uri?: string
    imageUri?: string
  }
}
```

Rules:

- Return `400` for malformed input or client validation errors that the backend refuses.
- Return `409` for stale duplicate launches or idempotency conflicts.
- Return `422` when the intent is valid JSON but cannot map to the official DBC config.
- Return `200` with `status: 'blocked'` when simulation or SDK transaction construction finds launch blockers.
- Never return a mainnet-submittable transaction unless `simulation.ok` is true.

## `POST /api/launches/:id/execute`

Purpose: execute only after the dry-run is still current and the signer explicitly approves.

Minimum request shape:

```ts
type ExecuteLaunchRequest = {
  dryRunId: string
  signerWallet: string
  approvedPayloadHash: string
  signedTransactionsBase64?: string[]
}
```

Minimum response shape:

```ts
type ExecuteLaunchResponse = {
  launchId: string
  status: 'submitted' | 'confirmed' | 'blocked'
  signatures?: string[]
  explorerUrl?: string
  error?: string
}
```

Rules:

- Reject execution if the payload hash differs from the last successful dry-run.
- Require explicit wallet approval; the browser must not auto-submit mainnet execution.
- Treat `409` with `status: 'blocked'` as an expected guarded result when `ALLOW_MAINNET_EXECUTE` is false.
- Persist normalized config, signer wallet, SDK version, transaction signatures, and simulation logs.

## `POST /api/launches/:id/leftover-route`

Purpose: after migration, route leftover assets from the configured receiver into rewards, treasury, and team vesting destinations.

Minimum request shape:

```ts
type LeftoverRouteRequest = {
  launchId: string
  receiverWallet: string
  routePlanHash: string
}
```

Minimum response shape:

```ts
type LeftoverRouteResponse = {
  launchId: string
  status: 'queued' | 'running' | 'complete' | 'blocked'
  steps: Array<{
    name: string
    status: 'pending' | 'running' | 'complete' | 'blocked'
    signature?: string
    error?: string
  }>
}
```

Rules:

- Backend must verify migration/withdrawal eligibility before routing.
- Routing should be resumable; partial completion is expected to happen in production.
- Team recipient rows with vesting should map to a real vesting mechanism before mainnet use.

## Current Frontend Wiring

- `src/lib/launchApi.ts` contains the typed dry-run client.
- `src/lib/phantom.ts` detects Phantom, connects to `window.phantom.solana`, and signs prepared legacy transactions.
- `src/App.tsx` calls the backend only when `VITE_LAUNCH_API_BASE_URL` is set.
- Without that env var, the UI remains local-only and cannot transmit launch data.
- `server/meteora.ts` maps UI `linear`/`exponential` shapes to 16-point DBC liquidity weights.
- `/api/launches/:id/execute` is blocked unless signed transactions are supplied and `ALLOW_MAINNET_EXECUTE=true`.
