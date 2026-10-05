# ShareHTML

[ShareHTML](https://github.com/jonesphillip/sharehtml) by Phillip Jones publishes HTML,
Markdown, and code files from the command line. Each file gets a link where readers
leave comments on selected text, react, and see who else is viewing. Documents are
stored in R2; comments, reactions, and presence live in Durable Objects. Licensed
Apache-2.0.

## Before you install

- **R2 enabled** on the account, for the documents.
- **Cloudflare Zero Trust** (free for up to 50 users) for Cloudflare Access sign-in,
  the default. Appflare's Cloudflare Access protection starts switched on for this app
  and needs a Zero Trust organization; with protection and sign-in turned off, the app
  installs without one.

## Notes

- **Sign-in.** Upstream offers Cloudflare Access or no sign-in at all. This entry
  defaults to Access. Without sign-in, anyone with the address can publish, read, and
  comment, as in upstream's local development mode.
- **Access values.** Appflare's Cloudflare Access protection puts every address behind
  Access and fills in `ACCESS_TEAM` (the team name alone) and `ACCESS_AUD`; everyone who
  uses this Appflare can sign in. Upstream's setup script creates the Access
  application with the Cloudflare API instead.
- **Installed before Appflare could protect apps?** Delete the Access application you
  made for the Worker in the Zero Trust dashboard and turn on **Cloudflare Access** on
  the app's page in Appflare; the team name and audience tag then come from Appflare.
- **Command-line tool.** Publishing goes through the `sharehtml` CLI (npm package, runs on
  Bun), which signs in through Access with `sharehtml login`.
- **Build.** The Worker package is built with Vite from upstream's top-level wrangler
  environment; the auth vars its production environment sets come from the install form.
- **Pin.** Upstream has no release tags, so the pin follows `main`.
