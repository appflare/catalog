# OpenSEO

[every-app/open-seo](https://github.com/every-app/open-seo) is a self-hosted SEO
research app: keyword research, rank tracking, domain and backlink overviews, and
site audits, with data from DataForSEO. An MCP server exposes the same research
to AI assistants.

OpenSEO ships its own installer, an Alchemy stack, so it is a self-deploying
entry: the sandbox Worker in your account checks out the pinned release, builds
it, and runs the stack with a Cloudflare API token you create for OpenSEO from the
permissions listed on the install page. The stack creates two Workers (the app
and its site-audit Worker, named after the install), a D1 database, an R2 bucket,
two KV namespaces, Durable Objects, two Workflows, cron triggers for rank checks
and cleanup, and a Cloudflare Access application that lets in only the emails you list. On an
account that has never used Alchemy, the first install also deploys Alchemy's
state store (an `alchemy-state-store` Worker and a Secrets Store holding its
keys), which later updates and the uninstall read. Uninstalling runs the stack's
own destroy, which deletes the app's data.

Installs and updates run in a container, so this entry needs Workers Paid and
sandbox builds enabled; each run takes a `standard-2` container for about 15
minutes. R2 must be enabled on the account. The app itself needs a DataForSEO
account, billed by DataForSEO per request.

This entry cannot offer everything a hand-run self-host can. Every secret a
catalog entry declares is required, so the optional integrations that need one
are left out: Google Search Console, SAM (the in-app agent, via OpenRouter), and
your own PostHog analytics. Worker variables set in the Cloudflare dashboard do
not last either: Alchemy sets the Workers' variables on every deploy, so each
update overwrites them.

The token's Workers Scripts Edit, Access: Apps and Policies Edit, and Secrets
Store Edit permissions apply to the whole account, so the installer could change
other Workers, Access applications, and secrets in it. Create the token for
OpenSEO alone, and do not reuse it.

OpenSEO is licensed under MIT. Pinned to upstream release tags; a maintainer
reviews and merges each bump, since CI does not install self-deploying entries.
