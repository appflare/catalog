# CattoPic

[CattoPic](https://github.com/Yuri-NagaSaki/CattoPic) by Firefly (Yuri-NagaSaki) is a
self-hosted image host. One Worker serves the React admin app and the API: upload
images, tag them, set an expiry, and get links to the original and to WebP and AVIF
copies made with the Images binding. A public endpoint redirects to a random image,
filtered by tag or orientation. Licensed GPL-3.0.

## Before you install

- **R2 enabled** on the account. Images are stored in the app's bucket and served
  straight from it, so the bucket needs public access (r2.dev or a custom domain),
  which you turn on after installing.

## Notes

- **API keys.** CattoPic has no sign-up page: every key is a row in the `api_keys`
  table of its D1 database, added with an SQL statement in the D1 console (the steps
  after installing show it). Add more keys, or delete them, the same way.
- **Public image URL.** `R2_PUBLIC_URL` replaces upstream's own bucket domain, which
  its wrangler config carries. Image links are built from it on every request, so
  setting it after uploading fixes the older links too.
- **Deletes and expiry.** Deleting images puts the R2 deletes on a queue; an hourly
  cron job removes expired images.
- **Images.** The Images binding makes the WebP and AVIF copies at upload; the free
  plan includes 5,000 unique transformations a month.
