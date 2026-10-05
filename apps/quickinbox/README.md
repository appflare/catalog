# Quickinbox

[Quickinbox](https://github.com/DivinPrince/quickinbox) by Irasubiza Divin Prince is
email for your own domain on Workers: a web mail client with threads, attachments in
R2, several users, addresses and domains, delivery status, and a REST API, CLI and MCP
server for scripts and AI agents. Licensed MIT.

## Before you install

- **A domain you control**, and one mail provider:
  - **Resend** (the default): works with any DNS host and Resend's free tier. You need
    an API key with full access.
  - **Cloudflare Email Service**: the domain on Cloudflare DNS with Email Sending and
    Email Routing turned on, and Workers Paid for sending.
- **R2 enabled**, for attachments.

## Notes

- **First run.** Open `/setup` to pick the domain and create the admin account.
- **Resend webhook.** After installing, create the webhook in Resend pointing at
  `/api/webhooks/resend` and paste its signing secret into the app's settings.
- **Cloudflare Email Service.** Point the zone's catch-all rule at the app's Worker in
  the Email Routing dashboard. Appflare does not set up routing for this app, since
  Resend installs need none.
- **Optional:** TypeSafe inbox tabs, Telegram notifications, and desktop push. The VAPID
  key pair is generated at install; push turns on once the push contact is set. An
  install made before the key was generated sets it with **Set new value** in Settings.
