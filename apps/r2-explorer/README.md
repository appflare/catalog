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

## Security

The template sets no authentication in code, and the configuration cannot be
changed through secrets or variables. Until you protect it, anyone who knows
the Worker's URL can list and download every file in the bucket. Protect it
with Cloudflare Access, which needs Zero Trust turned on (the free plan is
enough):

1. In the Cloudflare dashboard, open Workers & Pages and select the Worker.
2. Open the Access tab and choose Protect this Worker behind Access.
3. Select All traffic, pick who may sign in, and apply.

Access then checks every request before the Worker runs, on the `workers.dev`
URL and any custom domain.

## Read-only

The template runs R2 Explorer in read-only mode: the interface cannot upload,
move, or delete files. Add files with the Cloudflare dashboard or
`wrangler r2 object put <worker name>-bucket/<key> --file <path> --remote`.

## Versions

The source repository, `cloudflare/templates`, tags all of its templates
together, so this app's version follows those tags rather than the
`r2-explorer` package version, and a new tag can bring a new version even when
this template did not change.
