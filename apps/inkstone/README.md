# Inkstone

[Inkstone](https://github.com/shuaiplus/inkstone) by Shuai is a self-hosted Markdown
notebook on one Worker: a CodeMirror editor with live preview, folders, tags and
backlinks, D1 full-text search with optional semantic search on Workers AI, offline
editing and multi-device sync, public share links, a private MCP server, and WebDAV or
S3 backups. Licensed LGPL-3.0-only.

## Notes

- **First account.** The first account registered becomes the owner. Register as soon
  as the install finishes; later sign-ups stay closed until the owner opens them.
- **Database.** The Worker creates and upgrades its own D1 tables through versioned,
  idempotent migrations in its code, so the entry lists no SQL.
- **Durable Objects.** Upstream declares its two SQLite Durable Object classes with
  wrangler's `exports` block rather than `migrations`. The artifact keeps the block and
  the manager sends it with the upload, as wrangler does. This entry's maintainers
  have not yet run that path on a live install.
- **Attachments.** This entry installs upstream's R2 configuration (`wrangler.toml`).
  Upstream's KV variant (`wrangler.kv.toml`) is not offered.
- **Cron.** Two cron triggers run background indexing, cleanup and scheduled backups.
