# CF Server Monitor

[CF Server Monitor](https://github.com/huilang-me/CF-Server-Monitor) by huilang-me is a
server monitoring dashboard on Workers, D1 and a Durable Object. A small agent (Go by
default; shell and PowerShell scripts too) runs on each Linux, macOS, Windows, OpenWrt or
NAS machine and reports CPU, memory, disk, traffic and latency; the dashboard shows them
live, with history and a map, and the admin panel sends offline, threshold and expiry
alerts through Telegram, email (SMTP), Bark, DingTalk, Feishu or a webhook. Licensed MIT.

## Notes

- **Sign-in.** Open `/admin#/admin` and sign in with the admin user name (`admin` unless
  you changed it) and the agent secret as the password, then set a password of its own
  there. The agents keep using the agent secret.
- **Agent secret.** `API_SECRET` is generated. It is part of every agent's install
  command, so a new value means reinstalling the agent on each server.
- **Tables.** The Worker creates its D1 tables itself, on the first request to
  `/api/config`, which the install's health check makes. There are no migrations.
- **Cron triggers.** Two: every minute (offline and threshold alerts) and hourly (table
  rotation, cleanup, expiry reminders). The Workers Free plan allows 5 per account.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
