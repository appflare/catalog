# R2 Explorer

R2 Explorer is a Google Drive-like web interface for an R2 bucket: browse
folders, preview images, PDFs, text, Markdown and CSV files, and download
files. This entry installs Cloudflare's R2 Explorer template, which wraps the
[`r2-explorer`](https://github.com/G4brym/R2-Explorer) package with one bucket,
`<worker name>-bucket`, created at install.

## Before installing

R2 must be enabled on the Cloudflare account. Enabling it asks for a payment
method even though R2's free tier covers typical use, so the app is listed as
free-plan compatible but will not install on an account without R2.

The account also needs a Zero Trust organization for Cloudflare Access (see
Security below); its free plan is enough.

## Security

The template sets no authentication in code, and the configuration cannot be
changed through secrets or variables. Unprotected, anyone who knows the Worker's
URL could list and download every file in the bucket, so Appflare installs it
only behind Cloudflare Access, and its protection cannot be turned off: Access
checks every request before the Worker runs, on the `workers.dev` URL, its
previews and any domain, and lets in only the people who use this Appflare. That
needs a Zero Trust organization on the account (its free plan is enough).

Installed before Appflare could protect apps? Keep the Access application you made
for the Worker until Appflare's protection is on: the app has no sign-in of its own,
so deleting it first would open every file to anyone with the address. In the Zero
Trust dashboard, rename it to `Appflare: <name> (<Worker>)`, with the app's name as
Appflare lists it and its Worker name (for example `Appflare: R2 Explorer
(r2-explorer)`), then turn on **Cloudflare Access** on the app's page in Appflare.
Appflare takes that application over, keeping its audience tag and policies and
adding its own, as long as it covers only this app's addresses. Any other Access
application covering them must be deleted first.

## Read-only

The template runs R2 Explorer in read-only mode: the interface cannot upload,
move, or delete files. Add files with the Cloudflare dashboard or
`wrangler r2 object put <worker name>-bucket/<key> --file <path> --remote`.

## Versions

The source repository, `cloudflare/templates`, tags all of its templates
together, so this app's version follows those tags rather than the
`r2-explorer` package version, and a new tag can bring a new version even when
this template did not change.
