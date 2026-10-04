# OpenSEO

[every-app/open-seo](https://github.com/every-app/open-seo) is a self-hosted SEO
research app: keyword research, rank tracking, domain and backlink overviews, and
site audits, with data from DataForSEO. An MCP server exposes the same research
to AI assistants.

Upstream deploys to Cloudflare with an Alchemy stack, which builds the app with
Vite and deploys that build with the settings of the repository's own wrangler
configs. This entry installs the same build as a signed release instead, so
installs and updates need no sandbox Worker, no container and no API token of
their own. An install has two Workers: the app, and its site-audit Worker
(`<Worker name>-audit`), which only the app calls and which stays off
workers.dev. They share a D1 database (migrated on install and on every update),
an R2 bucket for cached DataForSEO answers, which are deleted after 7 days, and a
KV namespace. The app also gets a second KV namespace (for the MCP sign-ins of
upstream's hosted mode), the SAM chat Durable Object, the rank-check Workflow,
and two cron triggers: every 5 minutes for scheduled rank checks and stuck
audits, and a daily one that only the hosted mode uses. The audit Worker holds
the site-audit Workflow and its scratchpad Durable Object. R2 must be enabled on the account. The
app needs a DataForSEO account, billed by DataForSEO per request.

## Workers Free

Upstream says its Cloudflare self-host works on Cloudflare's free plan, and the
entry is listed for Workers Free on that basis: the two Workers and two cron
triggers fit it. Site audits are the part closest to Free's limits. The
site-audit Workflow fetches and analyzes up to 200 pages in each step (an audit
has 50 pages by default, so one step), and Workers Free gives a Workflow 10 ms of
CPU time and 50 external subrequests per run. If audits stop partway or report
pages they could not fetch on Workers Free, Workers Paid lifts those limits.

## Sign-in

OpenSEO's only sign-in for self-hosting is Cloudflare Access, so Appflare installs
it only protected with Cloudflare Access (the account needs a Zero Trust
organization) and fills in `TEAM_DOMAIN` and `POLICY_AUD` itself. Every Appflare
user can sign in, and everyone works in one shared workspace with the same
projects. No path stays public: in this mode the MCP endpoint, `/mcp`, signs
people in through Access as well. MCP clients connect with Access's Managed
OAuth, which you turn on for the app's Access application in the Zero Trust
dashboard, as upstream's
[operations guide](https://github.com/every-app/open-seo/blob/main/docs/SELF_HOSTING_CLOUDFLARE_OPERATIONS.md)
describes. Turning the app's protection off and on again in Appflare makes a new
Access application, so Managed OAuth must then be turned on again.

## Optional integrations

- **SAM**, the in-app agent: set the OpenRouter API key. OpenRouter bills its
  requests.
- **Google Search Console and Google Analytics**: set the Google OAuth client ID
  and secret, and add the app's address plus `/api/gsc/oauth/callback` and
  `/api/ga4/oauth/callback` as the client's redirect URIs (see upstream's
  `docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md`). The token encryption key is
  generated at install; changing it disconnects both.

Your own PostHog analytics cannot be set here: OpenSEO reads its PostHog key when
the app is built, and a catalog release is built once for everyone. Upstream's
anonymous telemetry stays on unless you set **Disable anonymous telemetry**.

## Installed while this entry ran its own installer?

Until OpenSEO 0.1.9, this entry ran upstream's Alchemy stack in your sandbox
Worker. Appflare cannot update such an install to this one: **Update** answers
"OpenSEO changed how it is installed (it no longer ships its own installer).
Uninstall it and install it again." Nothing carries over between the two. The new
install starts with an empty database, so note the projects, tracked keywords and
settings you want to keep first.

1. Install OpenSEO again. The new install runs beside the old one under other
   Worker names (`open-seo` and `open-seo-audit` by default, where the old ones
   are `open-seo-appflare-…`), so you can set it up before you remove the old one.
2. Uninstall the old install. This runs the stack's own destroy command in your
   sandbox Worker, which must still be connected and still hold the app's token,
   and deletes the old Workers, database, bucket, KV namespaces and the Access
   application the stack made. Then delete that token in the Cloudflare
   dashboard.
3. The stack's first deploy also left Alchemy's state store in the account (an
   `alchemy-state-store` Worker and a Secrets Store holding its keys). Delete them
   in the dashboard if nothing else of yours deploys with Alchemy. A Zero Trust
   team the stack created stays: Appflare's Access protection uses it.

OpenSEO is licensed under MIT. Pinned to upstream release tags.
