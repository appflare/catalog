# GentleMail

[Softwaiz/gentlemail](https://github.com/Softwaiz/gentlemail) is a multi-domain
webmail, email API and webhook service on one Worker, built with RedwoodSDK. Mail
arrives through the Email Routing catch-all and the Worker's `email` handler, is
stored in D1 (messages, mailboxes, users) and R2 (raw `.eml` and attachments), and
goes out through Cloudflare Email Service's `send_email` binding. A cron every
minute retries webhook deliveries.

The install creates the D1 database (with upstream's migrations) and the R2 bucket,
and asks for a zone: Email Routing is turned on there if it is off, and the zone's
catch-all is pointed at the Worker. Mail to an address without a mailbox is
rejected with a 550.

**First admin.** Upstream creates the first admin on a one-time `/setup` page that
asks for a `SETUP_TOKEN` secret. This entry creates that admin at install instead,
from the email and password in the install form (a D1 seed hashing the password the
way `src/lib/auth.ts` does), so `/setup` is never needed and `SETUP_TOKEN` is not
set. If every user is deleted later, `/setup` opens again and says to set
`SETUP_TOKEN`; add it as a secret on the Worker then.

**Domains.** The install zone is routed by Appflare, but GentleMail still needs the
domain added under **Admin → Domains** before mailboxes can be created there. For
more domains, run the commands that page shows. Their catch-all command names the
Worker `my-gentlemail`, the name upstream's `vite.config.mts` reads from its
wrangler config at build time; point it at the Worker Appflare installed instead
(`gentlemail` unless you changed it).

**Sending** needs Workers Paid and the domain onboarded to Email Sending
(`npx wrangler email sending enable <domain>`). Upstream requires Workers Paid
overall, so the entry is marked paid.

**Updates.** GentleMail checks GitHub once a day for a new release and shows admins
a notice with upstream's `git pull` steps. With Appflare, update from the app's
page in Appflare instead; the notice can be turned off in GentleMail's Admin.
