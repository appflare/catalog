# KontrolWP

[KontrolWP](https://kontrolwp.com) by Dynamic Technologies LLC is a dashboard for
many WordPress sites on one Worker: core, plugin and theme updates (on a schedule,
with a home page check that reverts a scheduled update that broke the site),
plugins, users, posts, pages and comments, uptime, analytics, Search Console and
per-site tools such as link checks, database cleanup and SEO. It uses D1, a queue
that syncs each site in the background, Cron Triggers and Browser Rendering. Licensed
GPL-3.0-only; the KontrolWP Connect plugin in the same repository is
GPL-2.0-or-later.

## Notes

- **Sign-in.** KontrolWP has no accounts of its own. It trusts Cloudflare Access
  and verifies the Access token on every API request, so the entry requires
  Appflare's Access protection and fills in `WEB_ACCESS_TEAM_DOMAIN` and
  `WEB_ACCESS_AUD`. Without them the API answers 503 and the dashboard shows its
  setup screen.
- **Encryption key.** Upstream's deploy script creates `SITE_SECRETS_KEY` on the
  first deploy and keeps it afterwards; here the install form generates it. Each
  site's secret is encrypted with it, so changing it later breaks every connected
  site until it is added again with a new Connection Key.
- **Build.** `npm run build` writes the KontrolWP Connect plugin zip into
  `public/downloads` (the dashboard offers it for download), then runs the Vite
  build. Upstream's `npm run deploy` adds only the D1 migrations and the deploy,
  which Appflare does itself.
- **Sites.** Each WordPress site runs the KontrolWP Connect plugin, which only
  answers requests signed with its Connection Key and never calls the dashboard,
  so no path needs to bypass Access.
