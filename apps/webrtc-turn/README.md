# AndroMeld TURN Relay

[webrtc_turn](https://github.com/heruoxin/webrtc_turn) by little_cup is a self-hosted
TURN relay for [AndroMeld](https://andromeld.catchingnow.com/), which connects your
phone, Mac and browser peer to peer. This entry installs its Cloudflare Worker (the
repository's `cloudflare/` directory); the Docker and coturn variant beside it is not
part of it. Licensed GPL-3.0-or-later.

## Notes

- **What the Worker does.** A `GET /?token=<token>` returns TURN credentials that are
  valid for 24 hours, minted from your Realtime TURN key; AndroMeld uses them only
  when a direct connection fails. Relayed traffic stays end-to-end encrypted. Every
  other path answers 404.
- **The setup page.** `GET /` without a token shows the full relay URL for 30 minutes
  after each deployment, then answers 404. Updating the app or changing its settings
  deploys it again, which reopens the page.
- **Billing.** TURN is billed by Cloudflare Realtime: the first 1,000 GB of egress
  each month is free, then $0.05 per GB. Upstream notes that Cloudflare requires a
  payment method on the account.
- **The token.** Without `ACCESS_TOKEN`, the token is derived from the TURN key's API
  token, so the relay URL survives updates but changes if you replace the key.
