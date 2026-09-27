# Atalaya

[Atalaya](https://github.com/dcarrillo/atalaya) (Spanish for watchtower) is an uptime
monitor and status page by Daniel Carrillo. A cron trigger runs HTTP, TCP and DNS
checks every minute, with retries and a failure threshold before alerting, optionally
from a chosen Cloudflare region through a Durable Object placed there. Results go to
D1; an hourly job rolls them up for the status page, an Astro site served by the same
Worker with 90 days of uptime bars and response-time charts. Alerts are webhooks with a
body template. Licensed Apache-2.0.

## Notes

- **Configuration.** Everything about the monitors lives in one var,
  `MONITORS_CONFIG`, as YAML. The install form is one line, so the default is a single
  line of JSON, which YAML also reads. Change it in the app's settings; upstream's
  [configuration guide](https://atalaya-docs.dcarrillo.es/configuration/) lists every
  field.
- **Secrets in the configuration.** `${NAME}` in the configuration is replaced with the
  Worker's binding of that name. The entry offers `AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID`, the names upstream's examples use, as optional secrets.
- **Status page access.** Basic auth with the username and password you enter, or
  public when **Public status page** is set.
- **Crons.** Two cron triggers (every minute, and hourly), out of the 5 an account has on
  the Workers Free plan.
- **Build.** The status page is built before the Worker is bundled, as upstream's deploy
  script does. Upstream's `[cache]` setting is not part of the artifact, so the Worker's
  responses are not cached in front of it; public status pages still send a one-minute
  `Cache-Control` header.
- **Versions.** Upstream has no releases; the entry follows the default branch.
