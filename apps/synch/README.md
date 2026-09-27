# Synch

[Synch](https://github.com/hjinco/synch) is end-to-end encrypted, real-time sync for
Obsidian vaults. Its Obsidian plugin encrypts every note and attachment on the device
with a vault key that is itself wrapped with a password only the devices know; this
entry installs the server the plugin talks to, upstream's self-hosted community
edition. One Worker handles sign-in (Better Auth on D1), a SQLite-backed Durable Object
coordinates each vault's live sync over WebSockets, and encrypted blobs go to R2.
Licensed MIT.

## Before you install

- **R2 enabled** on the account. Upstream's guide notes that a deployment fails
  without it.
- **The Synch plugin** in Obsidian, from its community plugins.

## Notes

- **Who can sign up.** Only the addresses in `AUTH_ALLOWED_EMAILS`; edit the list in the
  app's settings. Removing an address does not lock out an account that already exists.
- **Connecting.** In the plugin's settings, set **Self-hosted server** to the Worker's
  address without a trailing slash, then sign up or sign in.
- **Nothing to read on the server.** Notes and file contents reach the Worker already
  encrypted. A lost vault password cannot be recovered by the server or by Appflare.
- **Versions.** Each upstream release ships the plugin and the server together; the
  entry follows those releases.
