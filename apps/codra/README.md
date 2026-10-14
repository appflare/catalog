# Codra

[Codra](https://codra.run) is an AI code reviewer for GitHub pull requests by
Devarshi Shimpi. Codra runs as your own GitHub App. When a pull request opens or
changes, it reviews the diff and posts inline findings, a summary review and a check
run. A dashboard shows jobs, repositories, model routing and stats. It runs on
Workers with Queues, Workflows, KV and Workers AI, and stores its data in
PostgreSQL through Hyperdrive. Licensed AGPL-3.0. Upstream calls it beta.

## Before you install

- **A PostgreSQL 13+ database** reachable from the internet. Codra's first
  migration runs `CREATE EXTENSION IF NOT EXISTS pgcrypto`, which Neon and Supabase
  allow. The install form asks for its connection string, and Appflare creates a
  Hyperdrive configuration from it. Appflare sends the string to Cloudflare once and
  does not store it.
- **A GitHub App** of your own, created under
  [Settings > Developer settings > GitHub Apps](https://github.com/settings/apps/new)
  (or your organization's). The install form asks for its App ID, client ID, client
  secret and private key, so create it first. Use any homepage URL and leave the
  webhook inactive for now. Once the install has given Codra an address, the steps
  after the install set the real URLs, permissions and events.
- **Node.js 22 and git** on your computer, to run the database migrations.

## Notes

- **Tables.** Codra does not create or migrate its tables itself. Upstream applies
  them with `npm run migrate` from a checkout, which reads `DATABASE_URL`. Run it
  after the install and again after every update, from a checkout of the tag of the
  version Appflare installed. Until the first run, webhooks and the dashboard fail.
- **GitHub App permissions**, from upstream's
  [installation guide](https://codra.run/docs/installation): Contents and Metadata
  read-only; Pull requests, Checks and Issues read and write. Subscribe to the
  **Pull request** and **Issue comment** events. Codra also handles **Pull request
  review comment** and **Pull request review thread**, which record replies to its
  findings and resolved threads. Subscribing to them is optional.
- **Models.** Codra ships no default model. Choose one under **Settings > Default
  models** before the first review. Workers AI models need no key. Provider keys
  you add in the dashboard are encrypted with **Model key encryption key**.
- **Cloudflare API token.** Optional. With a token that has Workers AI Read on
  this account, refreshing models lists every Workers AI text model. Without one,
  Codra uses its built-in list. Appflare fills in the account ID.
- **Mentions.** A comment containing `@codra-app` asks for a review, whatever
  your GitHub App is called. That is upstream's built-in trigger, and the dashboard
  has no setting to change it.
- **Usage statistics.** Upstream sends anonymous statistics to codra.run after
  each review unless `TELEMETRY_DISABLED` is set: a random instance ID, the
  version, counts of lines, findings and tokens, the models used, file extensions,
  and the review's duration and verdict. This entry starts with them **off**. Turn
  them on under **Usage statistics to upstream** in the app's settings.
- **Address.** Upstream's wrangler config routes its own domain,
  `app.codra.devarshi.dev`. Installs never use it. Codra answers at the app's
  workers.dev URL or the custom domain you give it in Appflare. If the address
  changes, update the GitHub App's URLs to match.
- **Workers Free.** Upstream keeps each run within the free plan's 50 subrequests
  per invocation and continues a large pull request's review over several runs. The
  cron trigger runs every two minutes and takes one of the account's five free cron
  triggers.
