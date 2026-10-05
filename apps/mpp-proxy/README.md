# MPP Payment-Gated Proxy

[cloudflare/mpp-proxy](https://github.com/cloudflare/mpp-proxy) is a reverse proxy that
puts a paywall on paths of a site you already run. A client that requests a paid path
gets `402 Payment Required` with a Machine Payments Protocol challenge; once it pays on
Tempo, the proxy passes the request to your origin and sets a cookie that lets the
client back in for an hour. Everything else goes straight through. Licensed Apache-2.0.

## Notes

- **Origin.** Upstream can also reach the origin through DNS (when the proxy runs on a
  route of your zone) or a service binding to another Worker. An install answers on
  workers.dev and has neither, so the origin URL is required.
- **Wallet.** Upstream's config pays the burn address `0x…dEaD` by default, where
  payments are lost. The install form starts empty and asks for your own address.
- **Paid paths.** `PROTECTED_PATTERNS` is JSON. One payment opens every paid path, not
  only the one paid for, for an hour.
- **Direct access.** Clients that know the origin's own address can skip the proxy.
  Put the proxy on your site's domain, or let the origin accept only the proxy's
  requests.
- **Bot Management filtering** (humans free, bots pay) works only on a custom domain
  in a zone with Bot Management for Enterprise; on workers.dev every client pays.
- **Pin.** Upstream has no release tags, so the pin follows the default branch.
