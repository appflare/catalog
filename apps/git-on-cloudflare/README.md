# git-on-cloudflare

[git-on-cloudflare](https://github.com/zllovesuki/git-on-cloudflare) by Rachel Chen is
a git server speaking Smart HTTP v2 on Workers: each repository's refs live in a
SQLite-backed Durable Object and its packs in R2, a queue compacts packs in the
background, and a web interface browses code, commits and diffs. Licensed MIT.

## Before you install

- **Workers Paid.** The app assembles and hashes git packs in JavaScript and raises the
  CPU limit to five minutes per request.
- **R2 enabled**, for pack files.
- **An OpenID Connect provider** for sign-in. The variables keep the names of
  upstream's own provider, tessera, but any provider with discovery, the authorization
  code flow with PKCE and confidential clients works. Register a client with the
  redirect URI `<app URL>/auth/callback` and scopes `openid profile email`.

## Notes

- **Pushing.** Sign in at `/auth/account`, create repositories and personal access
  tokens there, and push with your namespace as the user name and a token as the
  password. Public repositories can be cloned and browsed without signing in.
- **Routes.** Upstream's own custom domains in its wrangler config are not installed.
- **Images.** Upstream publishes no logo or screenshots.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
