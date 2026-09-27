# Skland Daily Attendance

[skland-daily-attendance](https://github.com/AEtherside/skland-daily-attendance) claims
the daily sign-in rewards of Skland, Hypergryph's community app, for Arknights and
Arknights: Endfield, for every account whose credential you enter. It is built with
Nitro; on Workers it runs from a cron trigger every two hours and records each account's
success for the day in KV, so later runs that day skip it.

## Notes

- **Credentials.** Each account's credential is the `content` value of
  `https://web-api.hypergryph.com/account/info/hg` (or the Skland equivalent) while
  signed in. It is stored as a secret on the Worker.
- **Notifications.** Optional, through [Statocysts](https://github.com/octoplorer/statocysts)
  URLs, stored as a secret because they usually carry a bot token or webhook key.
- **Cron.** One trigger, `30 */2 * * *`, of the five the free plan allows per account.
- **Build.** Upstream's `nitro build` picks the Cloudflare preset only inside
  Cloudflare's own build environment, so the catalog build passes
  `--preset cloudflare_module`. The wrangler config has no `main`; the packer follows
  the deploy config Nitro writes, which keeps the KV binding and the cron trigger.
- **Licence.** The repository has no LICENSE file; `package.json` and the README both say
  MIT.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
