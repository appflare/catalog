# bashupload

[bashupload](https://github.com/DullJZ/bashupload-r2) by DullJZ is a file drop for the
terminal and the browser: `curl <app address> -T file` stores the file in R2 and returns a
link. A file is deleted after its first download, or, when the upload asks for a lifetime,
when that lifetime ends; a cron trigger sweeps expired files every five minutes. The
repository has no licence.

## Notes

- **Password.** Optional. Without it, anyone who finds the address can upload files to
  your bucket, within the rate limit of 10 uploads a minute per IP address. With it, every
  upload and download must send it in the `Authorization` header.
- **Upload size.** Upstream's default limit is 5 GB, but Cloudflare refuses request bodies
  over 100 MB on workers.dev and on Free and Pro zones, so the entry defaults to 100 MB.
- **Short links.** Uploads to `/short` send the file's link to a MyUrls service, by default
  the public instance upstream uses. Other uploads never contact it.
- **Web address.** Upstream serves the app on its own custom domain; the install serves it
  at the Worker's address, and a custom domain can be added afterwards.
- **Updates.** Upstream's tags version its Docker image and Helm chart, so the entry
  follows `main`.
