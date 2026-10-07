# Cloudflare OS

[cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) is the AI
productivity environment Cloudflare uses internally. People chat with agents that
do work by writing and running code, and ask them to build gadgets: small apps
that each run in a Dynamic Worker sandbox of their own, backed by a Durable
Object, private by default and shareable with others. Blueprints let people start
a gadget from someone else's code.

## What gets installed

Seventeen Workers: every Worker upstream's own deploy service offers to install.

- **router** (the app's address): serves the frontend, forwards `/api` to the
  workshop and `/gatekeeper/<name>` to that gatekeeper.
- **workshop** (`<Worker name>-workshop`): the backend. Its Durable Objects hold
  users, workspaces and admin settings; two KV namespaces hold blueprint metadata
  and avatars, and an R2 bucket holds blueprint code. It runs gadgets through a
  Worker Loader, renders PDF exports with Browser Rendering, and has a Workers AI
  binding.
- **context** (`<Worker name>-context`): the Context library, shared documents
  agents consult. It has a KV namespace of its own.
- **scheduler** (`<Worker name>-scheduler`): scheduled and recurring agent runs.
- Thirteen gatekeepers that connect agents and gadgets to outside services, each
  at `<Worker name>-<service>`: **cloudflare**, **confluence**, **github**,
  **google** (Gmail, Drive, Docs, Sheets, Calendar, Chat and BigQuery),
  **homeassistant**, **linear**, **mcp** (MCP servers people add themselves),
  **mcpportal** (one Cloudflare MCP server portal for everyone), **notion**,
  **slack**, **spotify**, **supabase** and **zoominfo**.

Only the router answers from the internet; the others stay off workers.dev and are
reached over service bindings. Dynamic Workers need Workers Paid, and the account
needs R2 and Browser Rendering.

Upstream's email gatekeeper is not installed. Upstream leaves it out of every
install too: it receives mail through Email Routing on a zone, which an app served
from workers.dev does not have.

## Sign-in

Upstream supports Cloudflare Access, passwords, and sign-in through its GitHub,
Google and Cloudflare gatekeepers. This entry builds the frontend in Access mode,
as upstream's own releases and the starter do, so Appflare installs the app only
behind Cloudflare Access (the account needs a Zero Trust organization) and fills
in `CF_ACCESS_ISS` and `CF_ACCESS_AUD` itself. Each person's account is their
Access email, created on first sign-in. Every Appflare user can sign in.

`ADMINS` lists the emails that may open `/admin`, where an admin sets the site's
name, logo and accent color, announcements, instructions for agents, and which
models and integrations people get. It is a JSON array of strings, each email in
double quotes: `["you@example.com", "ops@example.com"]`. The app compares each
email letter for letter with the one Cloudflare Access reports, so the upper and
lower case must match too. Text that is not a JSON array makes the admin page
fail.

## Connecting outside services

Each gatekeeper for an outside service, except Home Assistant and MCP, needs an
OAuth client of its own, which you create with that service. Enter its client ID
and secret under that service's name in the app's settings; a gatekeeper without
them shows people a not-configured page when they try to connect it. The service
sends people back to `<app address>/gatekeeper/<service>/oauth`, such as
`https://os.example.com/gatekeeper/github/oauth`; register that address as the
OAuth client's callback or redirect URL. Each field's link opens the page where the
service creates clients.

These addresses follow the app's address. Adding or removing a custom domain
changes every gatekeeper's `BASE_URL`, and with it the callback address it sends to
the service, so register the new `<app address>/gatekeeper/<service>/oauth` with
each OAuth client at the same time. Until then, connecting that service fails at
the provider with a redirect URL mismatch.

Home Assistant and MCP servers need no client: people enter their own Home
Assistant address and token, or MCP server address, in the app. For the MCP server
portal, set **MCP server portal address** to the portal's MCP endpoint; until then
that connector stays hidden.

## Models

Agents need a model. By default each user adds one under their settings with
their own provider key (Anthropic, OpenAI, Google, Workers AI and others).
Alternatively, set **AI Gateway name** to offer everyone the models of an AI
Gateway in this account. The workshop reaches the gateway through its Workers AI
binding, so the anthropic, openai and cloudflare providers need no token. The
google provider only works over HTTPS with **AI Gateway token**, and if
**AI Gateway providers** lists google without the token, the app refuses every
gateway model, not only Google's: list google only together with the token.

## Context data

Context keeps its library under a sharing domain. This entry leaves it at
Context's built-in value, `default`, on purpose; upstream's deploy service sets it
to the app's address instead. The sharing domain only keeps data apart between
deployments that share one Context Worker, and every Appflare install has its
own. Tying it to the app's address would split the library whenever a custom
domain is added or removed: people who joined before and after the change would
see different collections. The value stays fixed in future versions too, since
changing it would hide the Context data of existing installs.

## Updates

Upstream has no release tags, so this entry follows its default branch by commit.
The catalog's nightly bump proposes a newer commit only when it changes a file in
the directory of one of the 17 Workers' wrangler configs (`packages/router`,
`packages/workshop-backend` and `packages/gatekeeper-*`). A commit that changes
only the shared packages those Workers build from, such as the frontend in
`packages/workshop-frontend`, is picked up with the next commit that touches one of
those directories, not on its own. Upstream changes several times a day, so a
maintainer reads each bump before it publishes.
