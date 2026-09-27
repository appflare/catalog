# rdyrct

[rdyrct](https://github.com/baronunread/rdyrct) is a URL shortener for teams by Andrea
Bruno, the open-source code behind rdyrct.com. Organizations with owner, admin and member
roles share links; links take custom slugs, extra aliases and UTM parameters, and on
paid plans a QR code with a logo in the middle. Analytics show clicks by day, country,
referrer and device without storing an IP address.
Redirects are served from KV; clicks are buffered in a Durable Object and written to D1
in batches; queues and Workflows handle cleanup off the request path. An MCP server lets
AI assistants manage links. Licensed MIT.

## Before you install

- **A Resend account** with a verified sending domain. Sign-up and password reset send a
  one-time code by email, so a working `RESEND_API_KEY` and sender address are needed
  before anyone can sign up with a password (Google sign-in is optional).
- **R2 enabled**, for uploaded QR logos and avatars.

## Notes

- **Upstream's own values are replaced.** The wrangler config carries rdyrct.com's
  production settings: its URL, mail domain, Polar product ids, zone id and Sentry DSN.
  The entry sets the URL to this install's address and leaves the rest empty, so no
  errors are reported to upstream's Sentry project. Set **Short link host** to the host
  of the App URL (for example `rdyrct.<your subdomain>.workers.dev`), or to a custom
  domain once you attach one.
- **Plans.** The app is built as a service with Free, Hobby and Pro plans billed through
  Polar. Everyone starts on the Free plan's limits (QR codes and custom domains are on
  paid plans). Without Polar, the platform admin (`SUPERADMIN_EMAIL`) grants a plan to
  users by hand in the admin console.
- **Custom domains** for organizations need Cloudflare for SaaS on a zone of yours,
  `CF_ZONE_ID`, and a token with Zone, SSL and Certificates, Edit as `CF_API_TOKEN`, as
  upstream's README describes.
- **Rate limits.** Eleven rate limit bindings guard sign-in, email, writes, uploads and
  clicks. Their counters are per Cloudflare location and meant as abuse controls.
- **Crons.** Two cron triggers: a daily batch at 06:00 UTC and a 10-minute drain of
  pending storage work.
- **Versions.** Upstream has no releases; the entry follows the default branch.
