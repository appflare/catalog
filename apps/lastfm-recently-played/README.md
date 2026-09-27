# Last.fm Recently Played

[JeffreyCA/lastfm-recently-played-readme](https://github.com/JeffreyCA/lastfm-recently-played-readme)
renders your recent Last.fm scrobbles as an SVG card for a GitHub profile README, with
themes, colours, album art, now-playing bars, loved tracks and profile stats set by
query parameters. The page at the install's address is a configurator that builds the
card's URL. Licensed MIT.

## Notes

- **API key.** The Worker needs a Last.fm API key; the shared secret is not used.
- **Caching.** Cards go through the Workers cache in front of the Worker; Last.fm data is
  kept 60 seconds and album art a day, as upstream sets them.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
- No images: the repository's only image files are Last.fm's own logo and icon
  references.
