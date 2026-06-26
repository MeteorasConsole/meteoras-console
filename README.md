# Meteora's Console

React prototype for a Meteora DBC launchpad focused on `leftover_receiver` allocations.

The app models a guided launch setup flow:

1. Sign in with Phantom so the launch authority is explicit.
2. Collect token metadata, image, and quote asset.
3. Choose a linear or exponential pool shape based on the launch result the team wants.
4. Validate the `leftover_receiver` and reserve math.
5. Prepare the DBC config payload.
6. Click `Launch token` once; the app prepares the launch, asks Phantom for approval, then submits through the backend.

This prototype does not broadcast mainnet transactions directly from the browser. The execution boundary lives behind a backend and an explicit Phantom approval flow:

```bash
POST /api/launches/dry-run
POST /api/launches/:id/execute
POST /api/launches/:id/leftover-route
POST /api/metadata/pinata
POST /api/creator-fees/dry-run
POST /api/creator-fees/:id/execute
```

## Development

```bash
npm install
npm run dev
```

Run the API server in a second terminal:

```bash
npm run server:dev
```

For a production-like local run:

```bash
npm run build
npm run server:start
```

## Cloudflare Public Page

A safe static Cloudflare page lives in `cloudflare-site/` and is configured by `wrangler.toml`.

```bash
npm run cloudflare:preview
npm run cloudflare:deploy
```

See `docs/cloudflare.md` for the Cloudflare deployment notes and the separate full-app frontend/API requirements.

## Backend Dry-Run Mode

By default the app runs local deterministic developer functions only.

Set `VITE_LAUNCH_API_BASE_URL` to let the `Launch token` button prepare the launch, request Phantom approval, and call the backend execute endpoint:

```bash
VITE_LAUNCH_API_BASE_URL=http://127.0.0.1:8787
```

See `docs/launch-api-contract.md` for the current frontend contract.

The API server uses the official `@meteora-ag/dynamic-bonding-curve-sdk` to build unsigned DBC transactions. When the browser sends `wallet.publicKey`, that wallet is used as payer, fee claimer, and pool creator for the prepared launch transactions.

These public-key env vars are optional fallbacks for non-wallet dry-run calls:

```bash
RPC_URL=https://api.devnet.solana.com
LAUNCH_PAYER_PUBLIC_KEY=...
LAUNCH_FEE_CLAIMER_PUBLIC_KEY=...
LAUNCH_POOL_CREATOR_PUBLIC_KEY=...
```

Execution remains guarded: execute endpoints will not submit approved transactions unless `ALLOW_MAINNET_EXECUTE=true`. With the default false setting, Phantom-approved launch and creator-fee claim steps return a blocked execute result instead of being broadcast.

The API persists prepared dry-runs under `DATA_DIR` so execution can survive a process restart. For a shared production backend, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; the API will store launch and creator-fee claim state in `public.meteoras_console_state` instead of the local JSON file. Apply `supabase/migrations/202606250001_meteoras_console_state.sql` to the target project first.

## Shipping Notes

Minimum production env:

```bash
RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
VITE_LAUNCH_API_BASE_URL=https://your-api.example.com
CORS_ORIGIN=https://your-frontend.example.com
DATA_DIR=/data
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
DEFAULT_TOKEN_METADATA_URI=https://.../metadata.json
PINATA_JWT=...
PINATA_GATEWAY=your-gateway.mypinata.cloud
ALLOW_MAINNET_EXECUTE=true
```

The API rate-limits requests by client IP and runs Solana simulation before returning prepared launch or creator-fee claim transactions. Prepared transactions use recent blockhashes; if approval takes too long, prepare the action again.

The Token Brief panel includes a Pinata metadata agent. For a one-time upload, paste a Pinata JWT and gateway domain in the app, select token art, and run the agent; it uploads the image, uploads `metadata.json`, then fills `Metadata URI`. The app does not persist pasted Pinata credentials. For continuous runs, configure `PINATA_JWT` and `PINATA_GATEWAY` on the API server instead. Mainnet launches still need a metadata URI or `DEFAULT_TOKEN_METADATA_URI`. Optional first-buy is intentionally blocked until quote/minimum-out and slippage controls are wired.

## Current Integration Point

The developer function names in `src/lib/functions.ts` are intentionally close to backend RPC/tool names:

- `collect_launch_intent`
- `validate_leftover_receiver`
- `calculate_leftover_reserve`
- `prepare_metadata_upload`
- `build_meteora_dbc_config`
- `simulate_launch_transaction`
- `stage_leftover_receiver_routing`
- `ready_for_one_click_launch`

Swap the local deterministic functions with real API calls when the backend is ready.
