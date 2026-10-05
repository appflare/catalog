# OmniMail

[OmniMail](https://github.com/mibgb65-cloud/OmniMail) is a small self-hosted webmail
for your own domains, by the OmniMail contributors, deployed as one Worker. Email
Routing delivers mail to the Worker; a queue parses it into D1 and keeps the raw
message in R2. Users get mailboxes on the domains an administrator enables, with
quotas, invitations, drafts, replies and on-request translation (Workers AI). Sending
goes through Resend or SendFlare. Users can also connect external Gmail, Microsoft,
QQ, NAVER, Yandex, iCloud and Linux DO mailboxes, whose credentials are encrypted in D1.
Licensed MIT.

## Before you install

- **A zone in this account** for your addresses. The install turns Email Routing on for
  it and points its catch-all at the Worker. Upstream suggests a subdomain such as
  `inbox.example.com` when the domain already receives mail elsewhere.
- **R2 enabled.**
- For sending, a **Resend or SendFlare account** with a verified sender domain.

## Notes

- **Language.** The web app and the setup guide are in Chinese.
- **First run.** The first-run page asks for the setup token from the install form and
  creates the super administrator (the address in `SUPER_ADMIN_EMAIL`). After that the
  page refuses to run again, so the token no longer opens anything.
- **Other domains.** Each further receiving domain needs Email Routing with a catch-all
  to this Worker, set up in the Cloudflare dashboard, and the domain added in the app.
- **Free plan.** The app watches D1's free daily quota: once it is spent, the API answers
  503 and queued mail waits for the next day instead of failing.
- **Backups.** Optional daily D1 and mail backups to a second R2 bucket need
  `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` (the id of the install's D1 database)
  and a D1 Edit token as `D1_REST_API_TOKEN`, set in the Worker's settings.
- **Updates.** The app's own version check points at upstream's releases and fork sync;
  with Appflare, update from the app's page instead.
