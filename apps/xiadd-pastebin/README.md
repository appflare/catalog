# xiadd Pastebin

[Pastebin Worker](https://github.com/xiadd/pastebin-worker) by xiadd: post text with
syntax highlighting or Markdown, or upload a file up to 25 MB, and get a short link.
Pastes can have a password and an expiry time, from a minute to a month. Texts are kept
in D1, files in R2. A JSON API under `/api` does the same from scripts. Upstream runs it
at [as.al](https://as.al). Licensed MIT.

It is a different project from the catalog's Pastebin Worker (SharzyL/pastebin-worker),
hence the author's name in this entry's name.

## Notes

- **Public.** There is no sign-in: anyone who finds the address can post and upload.
- **Public URL.** `BASE_URL` builds the links the API returns and defaults to the
  Worker's workers.dev address. Change it when you add a custom domain.
- **Build.** TanStack Start with Nitro's Vite plugin and cloudflare-module preset. The
  wrangler config has no `main`; the packer follows the deploy config Nitro writes. The
  Drizzle migration in `drizzle/` runs on install and update.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
