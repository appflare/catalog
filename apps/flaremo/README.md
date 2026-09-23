# FlareMo

[realchendahuang/FlareMo](https://github.com/realchendahuang/FlareMo) is a notes app
for quick capture, compatible with the Memos API and clients. It has a timeline
with tags and attachments, projects with to-dos, articles and share pages, semantic
search over your notes, and an MCP server for AI assistants.

The install creates the D1 database (with upstream's migrations), an R2 bucket for
attachments and exports, two queues with the Worker as their consumer, two
Vectorize indexes (1024 dimensions, cosine) for semantic search, and a daily
maintenance cron. It asks for the app's public URL and generates the session
signing secret and the one-time setup secret for the owner account.

Everything fits the free plan for personal use: Queues allow 10,000 operations a
day, and the two indexes share Vectorize's free 5 million stored dimensions.

FlareMo is licensed under AGPL-3.0. Pinned to upstream release tags; new releases
merge on their own once the install check passes.
