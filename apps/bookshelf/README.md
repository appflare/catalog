# Bookshelf

[Bookshelf](https://murerkinn.github.io/bookshelf/) by Murat Erkin Cicek serves the
ebooks you own from an R2 bucket: a searchable shelf, EPUB and PDF readers in the
browser, reading profiles that remember where you got to, and an OPDS catalog for Kobo
and other e-readers. There is no database. Licensed MIT.

## Before you install

- **R2 enabled**, for the library.
- **Access control.** Bookshelf has no sign-in: anyone who can reach it can download
  every book. The install form puts it behind Cloudflare Access by default, which lets
  in only the people who use this Appflare and needs a Zero Trust organization on the
  account.

## Notes

- **Publishing books.** Books go into the bucket from a checkout of the repository with
  upstream's sync tool, which builds the library (metadata, covers, the catalog) and
  uploads it with wrangler. Point `bookshelf.config.json` and
  `apps/bookshelf/wrangler.jsonc` at the install's bucket, `<Worker name>-books`, and
  remove the EU jurisdiction from both, then run `npm run sync`.
- **Bucket location.** Upstream keeps its bucket in the EU jurisdiction; this install
  creates it in the default location.
- **E-readers.** KOReader, Kobo and other OPDS clients cannot sign in to Cloudflare
  Access, so the OPDS catalog (`/opds`) answers them only while the app is unprotected.
  Making `/opds` and the downloads public would publish the whole library, so the entry
  keeps them protected.
- **Read only** refuses changes to profiles and keeps reading positions in each
  browser, for a shelf strangers can reach.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
