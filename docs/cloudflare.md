# Cloudflare Web Page

This repo includes a Cloudflare-ready static public page under `cloudflare-site/`.

It is intentionally a marketing/status page, not the full launch console. The full console depends on the Node API for Meteora transaction preparation, Pinata uploads, Supabase state, and creator-fee claims. Keep those server secrets on the API host.

## Local Preview

```bash
npm run cloudflare:preview
```

Wrangler serves `cloudflare-site/` using `wrangler.toml`.

## Deploy

```bash
npx wrangler login
npm run cloudflare:deploy
```

The deployed page will be available on the Cloudflare Workers subdomain for the `meteoras-console` project unless a custom domain is attached.

## Full App Frontend

If you later deploy the full Vite app frontend to Cloudflare Pages, use:

```bash
npm run build
```

with `dist` as the build output directory, and set:

```bash
VITE_LAUNCH_API_BASE_URL=https://your-api.example.com
```

Then add the Cloudflare origin to the API server:

```bash
CORS_ORIGIN=https://your-cloudflare-domain.example,https://your-api-preview.pages.dev
```

Do not put `SUPABASE_SERVICE_ROLE_KEY`, `PINATA_JWT`, Helius keys, or launch execution secrets in frontend Cloudflare environment variables.
