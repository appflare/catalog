# HQBase

[HQBase](https://hqbase.io) is a shared email workspace for teams that runs in your own
Cloudflare account: shared mailboxes and access controls, drafts, labels, contacts,
signatures, audit history, and an OAuth-protected MCP server for agents. Licensed
AGPL-3.0-only. This entry installs the official release unchanged; it is not an
HQBase product.

## Notes

- **Plan.** Everything but sending fits Workers Free. HQBase sends through Cloudflare
  Email Service, which needs Workers Paid to send to any recipient.
- **First run.** Open `/setup` right after installing: the first person to finish it
  becomes the owner. Setup signs in to Cloudflare through HQBase's own OAuth app (via
  `auth.hqbase.io`) to connect your email domains: it points each zone's Email Routing
  catch-all at this Worker, onboards the domain to Email Sending, and can attach a
  hostname for the workspace. Appflare does not manage those settings, so after an
  uninstall, check the zone's catch-all rule and Workers custom domains.
- **Migrations.** The 29 migrations in `migrations/` run before the new version goes
  live; the 4 in `migrations-after-deploy/` run once it serves all traffic, because
  they drop what the previous version still reads. Upstream records the second set in
  its own `d1_migrations_after_deploy` table; Appflare records both sets in
  `d1_migrations`.
- **Updates.** Update through Appflare. HQBase's own Updates settings install releases
  through Workers Builds, which an Appflare install does not use, so they show a
  direct update as unavailable.
- **Worker name.** `HQBASE_WORKER_NAME`, which upstream's deploy script sets, is filled
  in with the install's Worker name.
