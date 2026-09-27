# CList

[CList](https://github.com/ooyyh/Cloudflare-Clist) by ooyyh puts one web interface and
one WebDAV endpoint over the storage you already have: S3-compatible buckets (R2
included), WebDAV servers, OneDrive, Google Drive, Aliyun Drive and Baidu Netdisk. It
previews common file types, makes share links, and keeps audit logs. Licensed MIT.

## Notes

- **Passwords are secrets.** Upstream's wrangler config declares the admin and WebDAV
  passwords as variables with the example value `changeme`; here they are Worker secrets,
  and those variables are left out. The admin password is generated at install; the
  WebDAV password is optional.
- **WebDAV** is off by default. Turned on, it serves `/dav/0/` (every storage) and
  `/dav/<storage id>/`, with the WebDAV credentials, or the admin ones when those are
  empty.
- **Database.** The app creates its tables on its first request.
- **Storage credentials** you add in the admin panel are kept in the D1 database.
- **Version.** Pinned to `master`: the latest tag, v1.2.0, predates the repository's
  licence file.
