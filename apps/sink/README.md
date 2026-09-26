# Sink

[Sink](https://github.com/miantiao-me/Sink) is a link shortener with visit analytics by
miantiao: custom and AI-suggested slugs, expiring and password-protected links, QR
codes, social previews, a realtime globe of visits, and daily backups to R2. It runs
as one Worker (Nuxt 4) with D1, KV, R2, Workers AI and Analytics Engine. Licensed
AGPL-3.0.

## Before you install

- **Analytics Engine enabled on the account.** Cloudflare refuses to deploy a Worker
  that writes to Analytics Engine until it is turned on once, under Storage &
  Databases > Analytics Engine in the dashboard.
- **R2 and Workers AI** available on the account.
- **Optional: an API token for the app** (`NUXT_CF_API_TOKEN`) with Account Analytics
  Read on this account. Without it, links work but the analytics pages stay empty.

## Notes

- **One install per account.** Visits go to the Analytics Engine dataset `sink`, the
  name Sink reads back by default. Dataset names are shared by the whole account, so a
  second install would show the first one's visits.
- **Site token.** `NUXT_SITE_TOKEN` is both the dashboard password and the API key.
- **The account id** (`NUXT_CF_ACCOUNT_ID`) is filled in with the id of the account the
  app is installed in.
- **Storage setup.** Appflare applies the D1 migrations. Open Links in the dashboard
  once after installing: Sink finishes its storage setup there and refuses to create
  links until it has.
- **Build.** Upstream's `pnpm build` relies on its `postinstall` and `prebuild` scripts
  to write the world map and the globe mesh, so they run as their own steps before the
  Nuxt build.
- **Not set up by the installer:** Cloudflare Access (`NUXT_CF_ACCESS_*`), click
  webhooks (`NUXT_WEBHOOK_*`), and the build-time options (`NUXT_API_CORS`,
  `NUXT_PUBLIC_*`), which a catalog build cannot change per install.
