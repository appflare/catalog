# Bookshelf

[Bookshelf](https://murerkinn.github.io/bookshelf/) by Murat Erkin Cicek serves the
ebooks you own from an R2 bucket: a searchable shelf, EPUB and PDF readers in the
browser, reading profiles that remember where you got to, and an OPDS catalog for Kobo
and other e-readers. There is no database. Licensed MIT.

## Before you install

- **R2 enabled**, for the library.
- **Access control.** Bookshelf has no sign-in: anyone who can reach it can download
  every book. Plan to put it behind Cloudflare Access, or turn its workers.dev address
  off and reach it another way.

## Notes

- **Publishing books.** Books go into the bucket from a checkout of the repository with
  upstream's sync tool, which builds the library (metadata, covers, the catalog) and
  uploads it with wrangler. Point `bookshelf.config.json` and
  `apps/bookshelf/wrangler.jsonc` at the install's bucket, `<Worker name>-books`, and
  remove the EU jurisdiction from both, then run `npm run sync`.
- **Bucket location.** Upstream keeps its bucket in the EU jurisdiction; this install
  creates it in the default location.
- **Read only** refuses changes to profiles and keeps reading positions in each
  browser, for a shelf strangers can reach.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
