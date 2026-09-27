# r2-webdav

[r2-webdav](https://github.com/abersheeran/r2-webdav) by Aber serves an R2 bucket over
WebDAV (Class 1 and 2, with locking), so it can be mounted as a network drive. Upstream
tests it against the litmus WebDAV suites. The repository has no licence.

## Notes

- **Sign-in.** One user name and password, over HTTP Basic authentication; both are
  required.
- **File size.** Cloudflare refuses request bodies over 100 MB on workers.dev and on Free
  and Pro zones, so larger files cannot be uploaded through the Worker.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
