# Relay

[Relay](https://github.com/YuriCrystal/relay) by YuriCrystal is a link shortener with click
analytics that keeps no cookies and no IPs: weighted A/B splits, routing by device and
country, per-channel suffixes (`/spring/ig`), conversion postbacks, Facebook Pixel, GA4
and GTM retargeting on an interstitial, password-protected and expiring links, QR codes
and CSV or JSON export. Licensed MIT.

## After you install

The Worker serves the short links and the admin API only. The dashboard is a single
`index.html` from the repository: open it in a browser, or host it anywhere static, and
under Settings enter the app's address and the admin key. It keeps the key in the
browser's local storage. Opened without them, it shows demo data.

## Notes

- **Time zone.** The daily and hourly charts use the time zone offset, which upstream
  sets to 8 (Taiwan). Change it in the app's settings.
- **Not included.** Upstream's optional KV cache for redirects and the daily cron that
  prunes old clicks are commented out in its config, so they are not part of this
  install; clicks are kept until deleted.
- **Updating an older database.** A database created before upstream added unique
  visitors needs `ALTER TABLE clicks ADD COLUMN visitor_hash TEXT DEFAULT '';` once.
  Installs made here start with the current tables.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
