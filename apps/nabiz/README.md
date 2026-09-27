# nabiz

[nabiz](https://github.com/productdevbook/nabiz) by Wind (productdevbook) is a status
page in one Worker: Astro renders the page, a cron trigger probes every monitor once a
minute, and D1 keeps the history. Licensed MIT.

## Notes

- **Monitors are rows, not settings.** Add them in the D1 console of the database
  named `<Worker name>-db` (see the install page), as upstream's `docs/monitors.md`
  describes. A new row is on the page at the next probe round.
- **Schema.** Upstream ships `schema.sql` rather than migrations. Every statement in
  it creates only what is missing, so it runs on every install and update. When a
  later version adds a column to an existing table, upstream's `docs/UPGRADING.md`
  lists the `ALTER` statements to run in the console; the schema file cannot add
  columns to a table that exists.
- **Limits on the free plan.** A probe round spends one subrequest per monitor plus a
  few for the database, so one install watches at most about 43 monitors.
- **Custom domain.** The page caches itself at the edge for less than a probe
  interval, which works only on a custom domain, not on workers.dev.
- **Alerts.** Telegram and the webhook are optional; both fire on a change of state,
  not on every minute of an outage.
