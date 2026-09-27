# screencapture Live

[screencapture](https://github.com/itschip/screencapture) by Christopher is a FiveM
resource that captures screenshots and video of a player's game view, as a
replacement for screenshot-basic. This entry installs its live-streaming Worker
(`workers/live`), which relays a player's game view to admins' browsers through
Cloudflare Realtime SFU. Licensed AGPL-3.0 (the repository's LICENSE file; its root
`package.json` still says MIT).

## Notes

- **Realtime.** Create a Serverless SFU app in the Cloudflare dashboard under
  Realtime and enter its App ID and App Secret when you install. Video is billed by
  Realtime: the first 1,000 GB of egress each month is free, then $0.05 per GB.
- **Capabilities.** Each stream has an unguessable ID and its own Durable Object. The
  owner capability stays on the FiveM server, the publisher capability goes only to
  the chosen player's game, and each viewer gets a one-time grant that expires after
  60 seconds. Players see an indicator while they are streamed.
- **Rate limit.** Creating a stream is limited to 10 a minute per IP address and
  Cloudflare location. That does not stop distributed abuse; upstream recommends WAF
  rules and budget alerts for a public server.
- **Viewer.** Admin panels watch a stream with upstream's `@screencapture/live` SDK.
