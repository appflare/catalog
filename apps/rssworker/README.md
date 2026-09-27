# RSSWorker

[yllhwa/RSSWorker](https://github.com/yllhwa/RSSWorker) is a lightweight RSS
generator in the spirit of RSSHub: it turns Bilibili user dynamics and videos,
Telegram channels, Weibo users and Xiaohongshu users into RSS feeds under `/rss/`.
Licensed MIT.

## Notes

- **Weibo.** Weibo feeds need the cookie of a signed-in session (see upstream's README
  for how to copy it); set it as the optional Weibo cookie secret.
- **Xiaohongshu.** Feeds take the user ID from the profile URL, not the Xiaohongshu
  number.
- **Build.** Upstream patches node-forge in a postinstall script. The catalog installs
  without running scripts, so the build applies the same patch with `patch-package`.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
- No images: the repository publishes none.
