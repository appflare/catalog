# shrtnr

[shrtnr](https://github.com/oddbit/shrtnr) is a URL shortener by [Oddbit](https://oddbit.id)
for teams, apps and AI assistants: a REST API with an OpenAPI spec and typed SDKs, an MCP
server, links owned by the person who created them, bundles that combine the clicks of a
campaign, and click analytics. One Worker with D1, KV and a Durable Object. Licensed
Apache-2.0.

## Before you install

- **Cloudflare Access.** The admin pages, the API key screens and the MCP server identify
  people through Access (free for up to 50 users). Short links redirect without it.

## Notes

- **Access after the install.** In the Zero Trust dashboard, add a self-hosted Access
  application for the app's address with the path `_/admin/*` (upstream's
  `docs/access-control.md`), then set its audience tag (`ACCESS_AUD`) and your team's
  key URL (`ACCESS_JWKS_URL`) in the app's settings in Appflare. Until both are set,
  the admin pages show setup steps.
- **Leave Appflare's Cloudflare Access protection off.** It covers every path of every
  address of the app, and the short links sit at the root (`/<slug>`), where no public
  path can be carved out, so every short link would ask visitors to sign in. The
  one-click Access for the workers.dev address in the Worker's settings does the same.
- **MCP.** The MCP server needs its own subdomain and a second Access application with
  Managed OAuth (`MCP_ACCESS_AUD`), as upstream's `docs/mcp.md` explains. Without it the
  Worker serves no MCP.
- **Migrations.** Appflare applies the D1 migrations at install and update. The Worker
  also carries them and checks the same `d1_migrations` table on its first request, so
  it finds nothing pending. `/_/health` reports the schema state and the version.
- **Visitor counting.** `FP_SALT` is generated at install; it makes the daily salt behind
  unique-visitor counts unpredictable. No IP addresses are stored.
- **Cache headers.** Upstream's `public/_headers` (long cache lifetimes for fonts and
  htmx) is not part of the artifact, so those files use the default caching.
- **Versions.** Upstream tags app releases `app-vX.Y.Z` next to its SDK releases, so
  the catalog sets the version itself and moves to new app releases by hand.
