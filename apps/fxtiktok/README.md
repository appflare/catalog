# fxTikTok

[okdargy/fxTikTok](https://github.com/okdargy/fxTikTok) fixes TikTok embeds on Discord
and similar apps: a TikTok link whose host is replaced by the install's address
previews the video, slideshow or live stream inline, with the author and counts, and
links back to TikTok. Licensed MIT.

## Notes

- **Media address.** Upstream sends video, image and avatar requests to its own
  offload host. The Worker serves the same routes, so an install points them at itself
  (the Media address setting), and the media streams through your Worker.
- **Direct links.** `?isDirect=true` answers with the media file itself and `?hq=true`
  asks for the higher quality video. Upstream also switches on these modes for any host
  name containing `d.` or `hq.`, so an account whose workers.dev subdomain ends in `d`
  gets direct links by default.
- **Pin.** Upstream has no release tags, so the pin follows the default branch,
  `hono-rewrite`, and each bump is reviewed by a maintainer. Upstream commits no
  lockfile, so dependencies are resolved at pack time.
- No images: the README's screenshots show Discord and TikTok branding and other
  people's videos.
