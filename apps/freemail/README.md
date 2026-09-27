# Freemail

[Freemail](https://github.com/idinging/freemail) by iding is a temporary and domain mail
service on your own domain. Email Routing hands every message sent to the domain to the
Worker, which keeps the headers and a preview in D1 and the raw message in R2. The admin
creates addresses, users with their own mailbox quotas, and per-mailbox logins in the web
app. Licensed Apache-2.0.

## Before you install

- **A domain on Cloudflare DNS**, with Email Routing available. The install turns Email
  Routing on for the zone you pick and points its catch-all rule at the app, and refuses
  when the catch-all already sends mail somewhere else.
- **R2 enabled** on the account, for the raw messages.

## Notes

- **Sending** is optional and goes through Resend, SendFlare or Cyberpersons with your own
  key, set as a secret in the app's settings. Cloudflare's own Email Sending is not used.
- **Root token.** `JWT_TOKEN` signs sessions and is also accepted as a full admin token by
  the API (`Authorization: Bearer`, `X-Admin-Token` or `?admin_token=`).
- **Forwarding** (`FORWARD_RULES`, or per mailbox in the app) only reaches destination
  addresses verified in the zone's Email Routing.
- **Storage.** Messages stay in D1 and R2 until they are deleted in the app.
- **Version.** The entry is pinned to the release tag `v5.3.1`. Upstream's default branch
  later rejects every incoming message that has no forwarding target, which bounces it
  back to the sender while still storing it, so the pin stays on the tag until the next
  release.
