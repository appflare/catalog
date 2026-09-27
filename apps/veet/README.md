# Veet

[Veet](https://github.com/megaconfidence/veet) by Confidence Okoghenun is a browser
video call app on one Worker: static assets serve the app, and a Durable Object per
meeting relays WebRTC signalling over WebSockets. Audio, video and chat travel peer to
peer and never pass through Cloudflare.

## Notes

- **Meetings.** Anyone with the address can start a meeting, and anyone with a
  meeting's link can join it. Every participant sends their stream to every other, so
  calls suit about four or five people.
- **TURN.** Without a TURN key, peers connect over STUN only, which fails behind
  symmetric NAT and strict firewalls. Create a TURN key in the Cloudflare dashboard
  under Realtime and enter its ID and API token in the app's settings; the Worker then
  hands each browser short-lived relay credentials.
- **Durable Objects.** Upstream declares the SQLite-backed class with wrangler's
  `exports` block rather than `migrations`. The artifact keeps the block and the
  manager sends it with the upload, as wrangler does.

The repository states no licence (no LICENSE file, nothing in its README or
`package.json`), so the entry shows none; no rights beyond viewing the code are
granted. The images in `public/` are left out for the same reason. Upstream has no
release tags; the entry follows the default branch.
