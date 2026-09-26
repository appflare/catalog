# Counterscale

[Counterscale](https://github.com/benvinegar/counterscale) is a web analytics tracker
and dashboard by Ben Vinegar. A small script on your pages reports pageviews to the
Worker, which writes them to Workers Analytics Engine; the dashboard reads them back
through the Analytics Engine SQL API. Licensed MIT.

## Before you install

- **Analytics Engine enabled on the account.** Cloudflare refuses to deploy a Worker
  that writes to Analytics Engine until it is turned on once, under Storage &
  Databases > Analytics Engine in the dashboard.
- **R2 enabled**, for the daily rollups.
- **An API token for the app** (`CF_BEARER_TOKEN`) with Account Analytics Read on this
  account. The install page links to a prefilled token form.

## Notes

- **One install per account.** Pageviews go to the Analytics Engine dataset
  `metricsDataset`, the name the dashboard's queries use. Dataset names are shared by
  the whole account, so a second install would read and write the same data. One
  install tracks any number of sites, each under its own `data-site-id`.
- **Password.** You enter the dashboard password; Appflare stores its bcrypt hash as
  `CF_PASSWORD_HASH`, which is what Counterscale checks, and computes it again when
  you change the password in the app's settings. `CF_JWT_SECRET` is generated.
- **The account id** (`CF_ACCOUNT_ID`) is filled in with the id of the account the app
  is installed in.
- **Retention.** Analytics Engine keeps 90 days. A cron job at 02:00 UTC copies each
  day to the R2 bucket as Apache Arrow files.
- **Build.** The tracker package is built and copied into the server's `public/` as
  `tracker.js`, then the React Router app is built, as upstream's turbo pipeline does.
  Upstream's `_headers` file (long cache lifetimes for the favicon and build assets)
  is not part of the artifact, so those assets use the default caching.
