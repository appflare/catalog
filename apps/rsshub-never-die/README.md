# RSSHub Never Die

[CaoMeiYouRen/rsshub-never-die](https://github.com/CaoMeiYouRen/rsshub-never-die) gives
your feed reader one RSSHub address that stays up when single public instances do not.
Each request goes to one of a pool of RSSHub instances: picked by weight, tried in turn
until one answers, or sent to several at once with the fastest answer returned.
Licensed MIT.

## Notes

- **Instances.** The pool starts with upstream's list of public instances plus
  https://rsshub.app. Their operators see your feed requests; put your own instance in
  the list if you run one.
- **Access key.** Optional. Without it anyone who finds the address can use it and
  spend your Worker's requests. With it, add `?authKey=<key>` to each feed URL, or
  `?authCode=` with the hex HMAC-SHA256 of the path keyed with it, so the key itself
  stays out of shared links.
- **Cache.** Answers are cached for five minutes by default through the Workers cache,
  which works only on a custom domain.
- **Build.** The Worker is built with upstream's `pnpm run build` (tsup).
- **Pin.** The newest release tag; the bump bot follows new tags.
- No images: the repository has none.
