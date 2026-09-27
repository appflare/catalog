# BinThere

[nxfu/binthere](https://github.com/nxfu/binthere) is a zero-knowledge pastebin. The browser
encrypts each note with AES-256-GCM before upload and keeps the key in the link's `#`
fragment, which never reaches the server. A Durable Object hands each note to exactly one
reader, and unread notes expire after 24 hours. Licensed MIT.

## Notes

- One Worker serves the static web app and the API, with notes in KV, a Durable Object for
  burn-after-read, and a rate limit of 30 new notes a minute per IP address.
- Nothing to configure: the install asks for no secrets or settings.
- **Pin.** The pin follows the default branch rather than the v1.1.0 tag, to include the
  fix that caps a paste's size while it streams in instead of after reading it whole. The
  bump bot moves it to the next release tag.
