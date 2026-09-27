# Jant

[Jant](https://github.com/jant-me/jant) is a personal microblog: short notes, links,
quotes and longer posts, threads and collections, media on R2, full-text search, RSS
and a sitemap, export and import, and an API and MCP endpoint so agents can post. This
entry installs [jant-starter](https://github.com/jant-me/jant-starter), the project
upstream's Deploy button uses, which runs the `@jant/core` package from npm. Jant is
licensed AGPL-3.0-or-later; the starter repository has no licence file of its own.

## After you install

Open the app right away. It starts with a setup page that creates the admin account,
and until that is done anyone who finds the address can do it instead. Site name,
language, theme and navigation are set in the app under Settings.

## Notes

- **Where the code comes from.** The Worker, its static files and its database
  migrations are all in `@jant/core`, at the version the starter's `package-lock.json`
  pins (0.8.0 at this pin). They are read from the installed package when the artifact
  is built, so reviewing a bump means reviewing the package version it moves to.
- **Data fixes.** Besides its schema migrations, Jant ships data fixes that upstream's
  `jant migrate` runs after them. Here they run after each deploy, once, and are
  recorded in `d1_migrations`.
- **Not included.** Serving the site under a subpath (`SITE_PATH_PREFIX`) needs
  upstream's deploy command to rewrite the static files, so it is not offered. S3
  storage instead of R2, and the hosted-service settings, are left out too.
- **Custom domain.** Add one to the app, then set it as the site address in the app's
  settings so links and feeds use it.
- **Updates.** The starter has no tags; upstream commits to `main` with each Jant
  release, and the entry follows it.
