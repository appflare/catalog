# Cloudmark

[Cloudmark](https://github.com/wesleyel/cloudmark) by Wesley Yang is a bookmark manager
without accounts. A collection is identified by its `mark` (part of the URL) and changed
with a write token; a bookmarklet or the Chrome extension saves the page you are on.
Bookmarks have categories, notes, and icons, and the list is built for the keyboard.
Stored in D1. Licensed AGPL-3.0.

## Notes

- **Open by design.** Anyone who can reach the Worker can create collections, and
  anyone who knows a collection's `mark` can read it. Changes need the write token,
  which D1 stores only as a SHA-256 hash. The Worker has no rate limit of its own.
- **Chrome extension.** Upstream publishes it as `cloudmark-chrome.zip` on its GitHub
  releases; set the server to the app's address in the extension's popup.
- **Domain.** Upstream's wrangler config attaches its own domain, cloudmark.site; the
  install uses the workers.dev address instead, and a custom domain can be added in
  Appflare.
- **Pin.** The repository's only tag releases the Chrome extension, so the pin follows
  `main`.
