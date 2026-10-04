# Projektor

Upstream's release bundle serves the web app with a `_headers` file that sets a
Content-Security-Policy on every page: scripts only from the app itself (plus
hashes of its inline scripts), no plugins, forms posting only to the app, and
`frame-ancestors 'none'`, so no other site can embed it in a frame. This install
serves the same web app without that file, so its pages carry no
Content-Security-Policy header. The app works the same; it is only less
hardened against injected scripts and framing. Attachments the Worker serves
itself keep their own strict policy, as upstream sets it in the Worker's code.

## Sign-in

Projektor signs people in only through Cloudflare Access, so Appflare installs it
only protected with Cloudflare Access (the account needs a Zero Trust organization)
and fills in `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE` itself. Every Appflare
user can sign in; the admin emails become workspace owners, and **Role for other
people** decides what everyone else gets.

Three paths stay public so MCP clients can connect without an Access session:
`/.well-known/*` (OAuth discovery), `/oauth/token`, and `/mcp/*`, which checks its
own OAuth and API tokens. Upstream's guide lists the first two; the MCP endpoint is
public too because Appflare's Access policy admits only its users, so an MCP client
could not reach it with an Access service token either, and Projektor refuses
service-token sign-ins anyway. `/oauth/authorize`, where you approve a client, stays
behind Access.

Two features reach people without an Access session, each checked by its own token, so
their paths are public too: issue share links (`/share/*`, the data and logo under
`/api/share/*`, and the page's scripts, styles and font under `/_astro/*` and
`/fonts/*`), and feedback that other sites send to `/api/feedback/submit` with a
feedback source's token. Everything else, the board, issues and wiki included, asks
for a sign-in.

Installed before Appflare could protect apps? Delete the Access applications you made
for the Worker in the Zero Trust dashboard, turn on **Cloudflare Access** on the app's
page in Appflare, then update.
