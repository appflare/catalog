# Garrul

[Garrul](https://garrul.com) by KingPin is a comment system for static sites and blogs:
an embeddable widget with threaded comments, reactions and votes, sign-in through
GitHub, Google, Discord and other OAuth providers or anonymous posting behind
Turnstile, a moderation queue, reply notification emails, and importers for Disqus,
Remark42, Comentario, isso and Cusdis. Licensed Apache-2.0.

## Before you install

- **A Turnstile widget.** Anonymous comments pass a Turnstile check. Create a widget
  under Turnstile in the Cloudflare dashboard for the app's hostname and paste its site
  key and secret key into the install form.
- **An OAuth app.** The admin pages sign in through OAuth only: whoever signs in with an
  address listed under Admin emails becomes an admin. Create an OAuth app with at least
  one provider (GitHub is the quickest) whose callback is
  `<app address>/api/v1/auth/<provider>/callback`.
- **Analytics Engine enabled on the account.** Cloudflare refuses to deploy a Worker
  that writes to Analytics Engine until it is turned on once, under Storage &
  Databases > Analytics Engine in the dashboard.

## Notes

- **One dataset per account.** Events go to the Analytics Engine dataset
  `garrul_events`, a name the whole account shares, so a second install writes to the
  same dataset and its usage page shows both.
- **Use a subdomain of your site.** On a `workers.dev` address the sign-in cookie is a
  third-party cookie inside your site, which Safari and Brave block. Anonymous
  comments, moderation and the admin pages work either way.
- **Email.** Reply notifications go through Resend: set the Resend API key and a sender
  address on a domain verified there.
- **Migrations.** Upstream's own runner records applied migrations in a `_migrations`
  table; Appflare applies the same files and records them in `d1_migrations`.
  A database first migrated by upstream's runner is not recognised as migrated.
- **Upstream's upgrade command** (`npm run upgrade`) is for deployments made from a
  checkout; installs made here update through Appflare.
