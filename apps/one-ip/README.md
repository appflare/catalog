# One IP

[One IP](https://github.com/zhihui-hu/one-ip) by Hu Zhihui is an IP and network
diagnostics site: look up any address's location, ASN, registration, reputation and risk
flags; check your own exit address, DNS and CDN, WebRTC leaks and browser fingerprint; run
a speed test and a ping from several regions; and see the status of AI services. One
Worker serves the React app and a JSON API that queries public lookup services. Licensed
AGPL-3.0.

## Notes

- **No storage.** Nothing is kept: every lookup goes to the public services the Worker
  calls.
- **Rate limits.** Two per-client limits from upstream's config (180 API requests and 5
  actions a minute); each install gets counters of its own.
- **Optional settings.** The verification page shows a Turnstile or reCAPTCHA widget only
  when its site key, secret and hostnames are all set. A Tianditu token switches the map
  from OpenStreetMap to Tianditu, for visitors in mainland China.
- **API.** `GET /api/ip/health?format=text` prints the caller's exit address with its
  trust score; `ip=<address>` checks another one.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
