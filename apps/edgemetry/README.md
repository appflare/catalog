# Edgemetry

[Edgemetry](https://github.com/hayaran/Edgemetry) by Nitin Hayaran is web analytics you
run yourself: a tracking script of about 2 KB, no cookies and no personal data at rest,
visitors, pageviews, bounce rate and time on page, breakdowns by page, referrer,
country, browser, device and UTM tag, filters that narrow every panel at once, a
realtime view and custom events. One install tracks any number of sites, and viewers
can be limited to the sites granted to them. Licensed MIT.

## After you install

- **Claim it first.** Open the app and create your account before sharing the address:
  until then `/setup` is open to anyone.
- **Sign-in has no throttle.** Upstream recommends a Cloudflare rate limiting rule on
  `/login` (5 requests per 10 seconds per IP), which needs the app on a custom domain of
  one of your zones, and Cloudflare Access in front of the dashboard. See upstream's
  POST-DEPLOY.md.
- **No password reset.** There is no email and no reset flow; add a second owner under
  Team so a lost password is not a lockout.

## Notes

- **Cron triggers.** An hourly and a nightly rollup; the nightly one drops the raw
  hourly tables it has rolled up. They count against the account's five cron triggers
  on the free plan.
- **D1 writes.** About 1.2 rows written per pageview, so the free plan's 100,000 rows
  a day covers tens of thousands of pageviews. Turning Filters off in the app's
  settings writes fewer.
- **Release check.** Once a day the Worker reads upstream's releases feed on GitHub to
  say whether a newer release exists; turn it off in the app's settings. Updates come
  from this catalog, not from that notice.
- **Password hashing.** PBKDF2 at upstream's 15,000 iterations, sized for the free
  plan's CPU limit, and not offered as a setting: changing it later invalidates every
  password.
