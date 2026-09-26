# Pastebin Worker

[SharzyL/pastebin-worker](https://github.com/SharzyL/pastebin-worker) is a pastebin for
text and files. Pastes get short or custom names, syntax highlighting, rendered
Markdown, optional client-side encryption, and an expiry; a paste can also be a short
link. It has an HTTP API built for `curl` and a small command-line client.

The install creates a KV namespace for small pastes and their metadata and an R2
bucket for pastes over 20 KB, plus a daily cron that removes expired files from R2. It
asks for the public URL and the name and contact address shown on the terms of
service page. Uploads are open to anyone until you list uploaders with bcrypt
password hashes.

Pastebin Worker is licensed under MIT. Upstream has no release tags, so the pin
follows the default branch and each bump is reviewed by a maintainer.
