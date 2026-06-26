# Meteora's Console

**The power-user launch console for Meteora DBC tokens.** Design the curve, control the supply, claim the fees — from your own wallet, with no app launch fees.

---

## The idea

Meteora ships a powerful SDK with everything you need to create and run a Dynamic Bonding Curve (DBC) launch. But almost every launchpad built on top of it optimizes for the same thing — the simplest possible UI — and in doing so buries most of what the SDK can actually do.

Meteora's Console goes the other way. Think of it as the **Cursor of launchpads**: instead of hiding the machinery behind a few buttons, it surfaces the full launch surface area and gives developers complete control of the experience.

- **Complete control** — bonding curve shape, market caps, fee schedule, reserve math, and routing are all yours to set.
- **Every function surfaced** — creator-fee claims, leftover routing, and multi-wallet bundling that other apps never expose.
- **You keep custody** — you launch from your own wallet via Phantom approval. The app never holds your keys.
- **No app launch fees** — you cover normal network/protocol costs; the app adds nothing on top.

> Independent public tool. **Not affiliated with Meteora.**

---

## Token

Meteora's Console has its own token on Solana.

**Contract address (CA):**

```
JKnnyJs7xbx217y3sCnPAH7K9C5at4nMbLSr8mrEASY
```

- Solscan: https://solscan.io/token/JKnnyJs7xbx217y3sCnPAH7K9C5at4nMbLSr8mrEASY

Always verify the CA before trading. The console itself is free to use and does not require the token to launch.

---

## What you can do

- **Token brief** — name, ticker, description, art, and metadata, with a built-in Pinata/IPFS agent that uploads the image + `metadata.json` and fills the metadata URI for you.
- **Curve design** — choose a linear or exponential pool shape and tune total supply, public float, initial/migration market caps, and the fee schedule.
- **Launch from your wallet** — prepare → Phantom approval → submit, with on-chain simulation before anything is signed.
- **Wallet bundler** — generate fresh wallets, split SOL into them from your wallet, and bundle-buy your freshly launched token across all of them for supply control (see below).
- **Creator fee claims** — claim creator trading fees from every pool you've launched.
- **`leftover_receiver` routing** — make the leftover receiver explicit up front, then withdraw and route leftover supply (rewards / treasury / team) after migration.

---

## How a launch works

1. **Sign in with Phantom** so the launch authority is explicit.
2. **Token brief** — collect metadata, art, and quote asset; upload metadata via the Pinata agent or paste a public URI.
3. **Curve** — pick linear or exponential and set supply, market caps, and fees.
4. **Reserve** — validate the `leftover_receiver` and reserve math.
5. **Prepare** the DBC config payload; the backend builds unsigned transactions and runs Solana simulation.
6. **Launch** — Phantom asks the connected wallet to approve, then the backend submits.

A DBC token's lifecycle: supply is split between a **public float** sold along the curve and a **leftover reserve**. When the curve hits its **migration market cap**, the pool migrates to a DAMM pool, and any base tokens not sold/consumed are **leftover** — reclaimable by the `leftover_receiver` via `withdrawLeftover`.

---

## Wallet bundler

A launch bundler for supply control. It generates burner wallets, funds them from your connected wallet, and has each one buy your launched token — so the first wave of supply lands in wallets you control instead of snipers'.

**Flow (3 steps in the UI):**

1. **Generate wallets** — pick a wallet count and a target % of supply. The backend creates fresh keypairs and quotes the curve to size how much SOL each wallet needs. Nothing moves on-chain yet; regenerate any time for a new set.
2. **Download wallet keys** — export the burner private keys to a file. Do this before funding — it's the only way to recover the SOL/tokens from those wallets later.
3. **Fund wallets & buy** — Phantom approves moving SOL from your wallet into the burners, then every burner buys the token.

**Notes & safety:**

- v1 fires the buys **rapid-fire** right after the pool confirms (not a Jito-atomic bundle).
- The "% of supply" is an estimate sized from a curve quote; each wallet buys with your slippage tolerance.
- Burner keys are stored server-side and **AES-256-GCM encrypted at rest** when `BUNDLER_KEY_SECRET` is set; if that secret is lost, stored keys can't be decrypted.
- Like every write path, bundle execution is gated by `ALLOW_MAINNET_EXECUTE`.

---

## API

The execution boundary lives behind a backend and an explicit Phantom approval flow — the browser never broadcasts mainnet transactions directly.

```bash
# Launch
POST /api/launches/dry-run
POST /api/launches/:id/execute
POST /api/launches/:id/leftover-route
GET  /api/launches?wallet=

# Metadata
POST /api/metadata/pinata

# Creator fees
POST /api/creator-fees/dry-run
POST /api/creator-fees/:id/execute

# Wallet bundler
POST /api/bundler/dry-run
POST /api/bundler/:id/execute
GET  /api/bundler/:id/keys
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

Execution remains guarded: execute endpoints will not submit approved transactions unless `ALLOW_MAINNET_EXECUTE=true`. With the default false setting, Phantom-approved launch, creator-fee claim, and bundler steps return a blocked execute result instead of being broadcast.

The API persists prepared dry-runs (and bundles) under `DATA_DIR` so execution can survive a process restart. For a shared production backend, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; the API will store launch, creator-fee claim, and bundle state in `public.meteoras_console_state` instead of the local JSON file. Apply `supabase/migrations/202606250001_meteoras_console_state.sql` to the target project first.

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

# Wallet bundler
BUNDLER_MAX_WALLETS=30
BUNDLER_GAS_BUFFER_SOL=0.005
BUNDLER_KEY_SECRET=...   # AES-256-GCM encrypts bundle wallet keys at rest
```

The API rate-limits requests by client IP and runs Solana simulation before returning prepared launch or creator-fee claim transactions. Prepared transactions use recent blockhashes; if approval takes too long, prepare the action again.

The Token Brief panel includes a Pinata metadata agent. For a one-time upload, paste a Pinata JWT and gateway domain in the app, select token art, and run the agent; it uploads the image, uploads `metadata.json`, then fills `Metadata URI`. The app does not persist pasted Pinata credentials. For continuous runs, configure `PINATA_JWT` and `PINATA_GATEWAY` on the API server instead. Mainnet launches still need a metadata URI or `DEFAULT_TOKEN_METADATA_URI`.

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

---

Independent public tool. Not affiliated with Meteora.
