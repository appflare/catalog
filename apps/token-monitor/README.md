# Token Monitor Hub

[Token Monitor](https://github.com/Javis603/token-monitor) by Javis is a desktop widget
that tracks token use, costs and plan limits across AI coding tools. This entry
installs its Cloudflare hub (the repository's `worker/` directory), which syncs those
numbers between your machines, in place of the self-hosted Node hub. Licensed MIT.

## Notes

- **The secret.** Every data route needs the hub secret, sent as
  `Authorization: Bearer <secret>`, as `x-token-monitor-secret`, or as `?secret=` for
  iOS widget runtimes that cannot send the header. A secret in a URL can end up in
  logs, so prefer the header.
- **Storage.** One SQLite-backed Durable Object keeps a record per device. A device
  counts as offline once its last post is older than `STALE_AFTER_MS` (10 minutes,
  from upstream's config).
- **Public stats.** Off unless you turn it on in the app's settings; the public
  endpoint leaves out per-device records and account identifiers.

The hub's code follows the widget's releases; the entry is pinned to a release tag and
moves when a later release changes the `worker/` directory.
