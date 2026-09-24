# Mailflare

[Mailflare](https://github.com/hieunc229/mailflare) is a self-hosted email service for
your own domains: mailboxes, forwarding and reject rules, a web inbox with real-time
updates, JMAP, and daily D1 backups to R2. It runs as one Worker (Next.js 16 through
OpenNext) with D1, R2, two queues it consumes, a SQLite Durable Object, a rate limit,
Images, and an `email` handler. License: AGPL-3.0.

## Before you install

- **Workers Paid.** Upstream requires it to send mail and recommends it overall. The
  Worker is about 2.5 MB compressed, close to the free plan's 3 MB limit.
- **A domain on Cloudflare DNS in this account**, with Email Routing available.
- **R2 enabled** on the account.
- **An API token for the app itself** (`CF_TOKEN`), separate from Appflare's token. On
  the zones you will connect: Zone Read, DNS Edit, Zone Settings Edit, and Email
  Routing Rules Edit; add the account's Email Sending Edit to send mail. Mailflare
  uses it to turn on Email Routing, write DNS records, and route each mailbox to its
  Worker. These are the permissions Cloudflare's API lists for the calls the app
  makes. Upstream's own docs name the routing permission "Email Routing Edit", but
  Cloudflare files turning Email Routing on under Zone Settings; they also list DNS
  Settings and Email Routing Addresses, which the app does not use.

## Notes

- **One install per account, named `mailflare`.** The app creates its Email Routing
  rules for the Worker named `mailflare`, so mail only arrives under that name. Its
  `WORKER_SELF_REFERENCE` service binding is not the reason: Appflare points that binding
  at the installed Worker whatever its name.
- **Email Routing is left to the app.** Appflare does not create routing rules for
  Mailflare; the app enables routing and adds a rule per mailbox when you connect a
  domain and create mailboxes.
- **Migrations.** Appflare applies the D1 migrations at install and update. The app's
  own `/setup` check reads the same `d1_migrations` table and finds nothing pending.
- **Not set up by the installer:** Turnstile (its site key is baked in at build time,
  and a catalog build has none, so do not set `TURNSTILE_SECRET_KEY`), upstream's
  GitHub update workflow (`GITHUB_UPDATE_*`; Appflare updates the app), and the Docker
  relay settings (`INBOUND_WEBHOOK_SECRET`, `SMTP_*`).
- **Uninstalling leaves the app's routing rules.** Mailflare created them with its own
  token, so Appflare does not know about them. Remove the rules and catch-all that
  point at `mailflare` under Email Routing on each connected domain, or mail to those
  addresses fails once the Worker is gone.
- **Build.** `opennextjs-cloudflare build` runs the app's own `build` script, which
  bundles the D1 migrations into the app and runs `next build`, then writes
  `.open-next/`, which the wrangler config deploys.
- **Health.** `/api/setup/status` needs no sign-in, reads D1, and answers before the
  first admin exists.

## After installing

Open `/setup` on the Worker's URL to create the first admin, then add your domain and
create mailboxes from the app.
