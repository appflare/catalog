# Usage Guard Collector

[usage-guard-collector](https://github.com/HowardZlh/usage-guard-collector) by Howard
warns you about a Cloudflare usage surge before the invoice does. Every 6 hours it reads
the account's daily counts from the GraphQL Analytics API (Workers requests, errors and
CPU time; D1 rows and queries; Durable Objects requests; KV operations; R2 class A and B
operations; Queues operations) into its own D1 database. A metric is flagged when today's
total is at least 10 times the median of the previous 7 days and above a floor, and the
alert goes to Discord or Slack. Licensed MIT.

It never calls a Cloudflare write API: it cannot stop a Worker or change a setting.

## Before you install

- **An API token for the app** (`CF_API_TOKEN`) with Account Analytics Read on this
  account and nothing else. The install page links to a prefilled token form.

## Notes

- **The account id** (`CF_ACCOUNT_ID`) is filled in with the id of the account the app is
  installed in.
- **Cron.** One trigger, every 6 hours, of the five the Workers free plan allows per
  account.
- **Status page.** `GET /` shows the last 7 days and the current surges. It has no
  sign-in; put the Worker behind Cloudflare Access to keep it private.
- **Numbers.** These are analytics counts, not the invoice, and sit a little above what
  is billed.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
