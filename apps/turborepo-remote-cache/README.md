# Turborepo Remote Cache

[AdiRishi/turborepo-remote-cache-cloudflare](https://github.com/AdiRishi/turborepo-remote-cache-cloudflare)
implements Turborepo's remote cache API on Workers, storing build outputs in R2. Set
`TURBO_API`, `TURBO_TEAM` and `TURBO_TOKEN` wherever turbo runs, and machines and CI share
one cache without Vercel. Licensed MIT.

## Notes

- **Storage.** Upstream can keep the cache in KV instead of R2, but its wrangler config
  binds R2, so an install uses R2 (enable it on the account first).
- **Expiry.** A cron trigger at 03:00 UTC deletes cache entries older than the cache
  lifetime setting (720 hours by default). It uses one of the account's cron triggers (5 on
  the free plan).
- **Pin.** The pin follows the default branch rather than the v4.0.0 tag, which bundles an
  older Hono with published advisories for the CORS and cache middleware the server uses.
  The bump bot moves it to the next release tag.
