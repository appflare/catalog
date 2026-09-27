# Email Explorer

[Email Explorer](https://github.com/G4brym/email-explorer) is an email client by
Gabriel Massadas that runs in your Cloudflare account. Email Routing delivers mail to
the Worker, each mailbox lives in its own SQLite Durable Object, and attachments go to
R2. The web app (Vue) has folders, search, contacts, a rich text composer, and users
with per-mailbox roles. Licensed MIT.

## Before you install

- **A domain on Cloudflare** with Email Routing available. Appflare turns routing on
  for the zone you pick and points its catch-all rule at the Worker; the install
  stops if the catch-all already sends mail somewhere else.
- **R2 enabled**, for message bodies and attachments.

## Notes

- **The first account is the admin.** Registration is open until someone registers,
  then closes. Open the app and register as soon as the install finishes. The admin
  adds other users and grants them mailboxes.
- **Mailboxes appear on their own**, one for each address that receives mail.
- **Sending** uses the `SEND_EMAIL` binding. Without Email Sending on the domain it
  reaches only addresses verified under Email Routing.
- **Password reset by email** is off: upstream turns it on with an option compiled
  into the Worker, and the build here keeps upstream's default.
- **Build.** The entry packs upstream's own deployment Worker from the pnpm workspace
  (`packages/worker/dev`), which is what the Deploy button's template installs from
  npm.
