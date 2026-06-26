# Meteora DBC Integration Notes

These notes summarize the official DBC docs used for the current backend implementation.

## Official Sources Used

- DBC SDK install/init: `https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/getting-started.md`
- DBC SDK reference: `https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/reference.md`
- DBC SDK examples: `https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/examples.md`
- DBC launch configuration: `https://docs.meteora.ag/core-products/dbc/launch-configurations.md`
- DBC surplus and leftover: `https://docs.meteora.ag/core-products/dbc/surplus-and-leftover.md`
- DBC program instructions: `https://docs.meteora.ag/developer-guides/dbc/program/instructions.md`

## SDK Surface Confirmed

- Package: `@meteora-ag/dynamic-bonding-curve-sdk`.
- Installed version: `1.5.10`.
- Default DBC program ID in docs: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.
- Main client: `DynamicBondingCurveClient.create(connection, 'confirmed')`.
- Config builder used: `buildCurveWithLiquidityWeights`.
- Partner transaction builder used: `client.partner.createConfigAndPoolWithFirstBuy`.
- Leftover transaction builder used: `client.migration.withdrawLeftover`.

## Product Mapping

The UI exposes `linear` and `exponential` pool shapes. DBC does not expose those as named pool presets; the backend maps those labels to explicit liquidity weights:

- `linear`: sixteen equal weights, making price movement easier to reason about.
- `exponential`: high early weights descending to lower late weights, making price movement accelerate toward migration.

The backend uses fixed base fees by setting `startingFeeBps` and `endingFeeBps` to the same value with `numberOfPeriod: 0` and `totalDuration: 0`, which satisfies the SDK validator for a non-decaying scheduled fee.

## Current Backend Behavior

- `POST /api/launches/dry-run` builds `createConfig` and `createPool` transactions.
- When `wallet.publicKey` is supplied, that wallet is used as payer, fee claimer, and pool creator. The `LAUNCH_*_PUBLIC_KEY` env vars are fallback-only for non-wallet requests.
- The server generates dry-run `config` and `baseMint` keypairs and stores them in memory for the dev session.
- The server partial-signs the generated `config` and `baseMint` keypairs before returning transactions.
- The dry-run returns derived `pool`, `config`, `baseMint`, `quoteMint`, generated transaction base64, required signer public keys, and a payload hash.
- The frontend detects Phantom, connects via `window.phantom.solana`, signs prepared legacy transactions with Phantom, and posts `signedTransactionsBase64` to `/execute`.
- The dry-run does not submit transactions.
- `/api/launches/:id/execute` rejects by default unless `ALLOW_MAINNET_EXECUTE=true` and signed transactions are supplied.
- `/api/launches/:id/leftover-route` builds an unsigned `withdrawLeftover` transaction for a stored launch after migration.

## Known Gaps

- Metadata upload is not implemented. The server uses `metadataUri` from the request or `DEFAULT_TOKEN_METADATA_URI`.
- Optional first buy is modeled in the UI but not included in generated transactions yet because minimum-out quoting and signer UX need to be implemented.
- Dry-run transaction keypairs are stored in memory only; production needs durable encrypted storage or client-owned keypair generation.
- Execute flow is intentionally blocked by default.
- Team vesting rows are modeled but not mapped to a real vesting program yet.

## Dependency Audit

`npm audit --omit=dev` currently reports Solana/Anchor transitive advisories through `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`, `bigint-buffer`, and `uuid`. npm reports no direct fix path for the installed SDK dependency tree. Do not run blind `npm audit fix` without testing SDK compatibility.
