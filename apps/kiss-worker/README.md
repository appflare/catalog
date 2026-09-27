# KISS Worker

[fishjar/kiss-worker](https://github.com/fishjar/kiss-worker) by Gabe is the sync
server of [KISS Translator](https://github.com/fishjar/kiss-translator), a browser
extension and userscript for bilingual web page translation. The extension syncs its
settings, rules and vocabulary through `POST /sync` and serves shared rule sets from
`GET /rules`.

## Notes

- **Sync password.** The install generates `AUTH_VALUE`. Copy it from the install
  form into the extension's Sync Key; it cannot be read back from the app's settings
  later, only replaced (and then every browser needs the new value).
- **Storage.** One SQLite Durable Object per synced key orders concurrent writes. The
  KV namespace exists for upstream's older KV-only server, whose records the objects
  copy over on first read; on a fresh install it stays empty.
- **Durable Objects.** Upstream declares the class with wrangler's `exports` block
  rather than `migrations`. The artifact keeps the block and the manager sends it with
  the upload, as wrangler does.
- **Health check.** `/rules` without a share key answers 403 from the Worker's own
  code once the sync password is set (503 without it), so the check probes it instead
  of `/`, which answers 404.

KISS Worker is licensed under MIT. Upstream has no release tags; the entry follows
the default branch.
