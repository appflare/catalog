# Agentic Inbox

[cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) is a
self-hosted email client with an AI agent. Mail for your domain arrives through
Email Routing, each mailbox lives in its own Durable Object with a SQLite database,
attachments go to R2, and an agent built on the Agents SDK and Workers AI reads,
searches, and drafts replies (it never sends without your confirmation). An MCP
server exposes the mailboxes to AI coding tools.

The install creates the R2 bucket and the three Durable Object classes, and asks
for a zone: Email Routing is turned on there if it is off, and the zone's
catch-all rule sends mail to the Worker. The app refuses every request until
Cloudflare Access protects it; after installing, turn on Access for the Worker and
set the two secrets the Access dialog shows.

Receiving is free. Sending reaches only addresses verified in Email Routing unless
the domain is onboarded to Email Sending, which needs Workers Paid.

Upstream has no release tags, so this entry follows its default branch by commit.
