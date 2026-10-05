# Agentic Inbox

[cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) is a
self-hosted email client with an AI agent. Mail for your domain arrives through
Email Routing, each mailbox lives in its own Durable Object with a SQLite database,
attachments go to R2, and an agent built on the Agents SDK and Workers AI reads,
searches, and drafts replies (it never sends without your confirmation). An MCP
server exposes the mailboxes to AI coding tools.

The install creates the R2 bucket and the three Durable Object classes, and asks
for a zone: Email Routing is turned on there if it is off, and the zone's
catch-all rule sends mail to the Worker.

The app has no sign-in of its own: it refuses every request that Cloudflare Access
has not signed in. Appflare installs it only protected with Cloudflare Access, so the
account needs a Zero Trust organization, and fills in `TEAM_DOMAIN` and `POLICY_AUD`
itself. Every Appflare user can sign in and read every mailbox.

Installed before Appflare could protect apps? Delete the Access application you made
for the Worker in the Zero Trust dashboard, turn on **Cloudflare Access** on the app's
page in Appflare, then update. The `POLICY_AUD` and `TEAM_DOMAIN` secrets you set by
hand are replaced by the values Appflare fills in.

Receiving is free. Sending reaches only addresses verified in Email Routing unless
the domain is onboarded to Email Sending, which needs Workers Paid.

Upstream has no release tags, so this entry follows its default branch by commit.
