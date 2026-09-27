# Renewlet

[Renewlet](https://github.com/zhiyingzzhou/renewlet) by zhiyingzhou tracks recurring
subscriptions: renewal reminders in each user's own timezone over email, Telegram,
Bark, webhooks and more, a calendar feed, budgets, cost sharing, spending
statistics and a public status page. It runs as one Worker with D1, R2 for
uploaded logos, and a queue for refreshing its built-in icon index. Licensed MIT.

## Notes

- **First admin.** `/setup` creates the admin account while none exists, so open it
  right after the install.
- **Cron.** One trigger, every minute: it finds the reminders due in each user's
  local time. It counts toward the account's cron triggers (5 on Workers Free).
- **Build.** Upstream's `build:cloudflare` script builds the React app for the
  Worker API; the install here uses the same script.
- **Updates.** Upstream deploys with its own deploy script, which also runs steps
  around the D1 migrations: it backs up and restores calendar feeds, rebuilds
  derived subscription state, checks foreign keys, and, for migrations named
  `NNNN_exclusive_*.sql`, first deploys a maintenance version and waits 15 minutes
  for running cron and queue work to drain. A fresh install needs none of this.
  Appflare applies the migrations while the previous version keeps serving, so when
  reviewing a bump, check new migrations for the `_exclusive_` marker and for
  tables the backfill in `scripts/backfill-cloudflare-subscription-derived-state.ts`
  rebuilds, and hold the bump when either appears.
