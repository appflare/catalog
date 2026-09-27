# Minvoice

[Minvoice](https://github.com/ddyy/minvoice) by Daniel Yang is invoicing for a single
business. You create invoices and send them by email with a PDF attached; each one gets a
pay link where the client pays by card through Stripe Checkout or through PayPal. It
keeps an activity history per invoice, monthly reports, CSV export, and optional
payment reminders. Clients see emails, the pay page and the PDF in English, Spanish,
German or French. Licensed MIT.

The install creates a D1 database and a daily cron (15:00 UTC) that sends overdue
reminders once you switch them on in Settings.

## Before you install

Nothing beyond the Worker itself. Stripe, PayPal and email are each optional: without
them, clients still get the pay page, print view and PDF, and you record payments by
hand.

## Notes

- **Sign-in.** `/admin` uses the admin password. To protect it with Cloudflare Access
  instead, attach a custom domain to the Worker, create an Access application for the
  `/admin` path, and set the team domain and audience tag in the app's settings; the
  password sign-in then turns off.
- **API keys.** Stripe, PayPal and Resend keys can be set here as secrets or entered in
  the app's Settings page, which stores them in D1 encrypted with the generated
  `SETTINGS_MASTER_KEY`.
- **Email.** Resend is the email provider: verify your sending domain at Resend and add
  its API key. Upstream's other provider, Cloudflare Email Sending, needs a `send_email`
  binding that only its production config has, so it is not available here.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
