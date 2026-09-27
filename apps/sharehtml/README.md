# ShareHTML

[ShareHTML](https://github.com/jonesphillip/sharehtml) by Phillip Jones publishes HTML,
Markdown, and code files from the command line. Each file gets a link where readers
leave comments on selected text, react, and see who else is viewing. Documents are
stored in R2; comments, reactions, and presence live in Durable Objects. Licensed
Apache-2.0.

## Before you install

- **R2 enabled** on the account, for the documents.
- **Cloudflare Zero Trust** (free for up to 50 users) if you keep Cloudflare Access
  sign-in, the default. Access is turned on for the Worker after it exists, so the app
  answers 401 until you do that and enter the two Access values in its settings.

## Notes

- **Sign-in.** Upstream offers Cloudflare Access or no sign-in at all. This entry
  defaults to Access. Without sign-in, anyone with the address can publish, read, and
  comment, as in upstream's local development mode.
- **Access values.** `ACCESS_TEAM` (the team name) and `ACCESS_AUD` (the application's
  audience tag) are vars, so they are set in the app's settings in Appflare and kept by
  updates. Upstream's setup script creates the Access application with the Cloudflare
  API; here you turn it on from the Worker's Domains & Routes settings.
- **Command-line tool.** Publishing goes through the `sharehtml` CLI (npm package, runs on
  Bun), which signs in through Access with `sharehtml login`.
- **Build.** The Worker package is built with Vite from upstream's top-level wrangler
  environment; the auth vars its production environment sets come from the install form.
- **Pin.** Upstream has no release tags, so the pin follows `main` and each bump is
  reviewed by a maintainer.
