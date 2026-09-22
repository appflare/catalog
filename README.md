# Appflare catalog

The public catalog of apps installable with [Appflare](https://github.com/appflare/appflare),
a self-hosted app manager for Cloudflare.

Each app lives in `apps/<slug>/appflare.jsonc`. CI builds a signed artifact from the
pinned upstream commit, publishes it as a GitHub Release `<slug>@<version>`, and lists
it in `index.json`, served from GitHub Pages. See [CONTRIBUTING.md](CONTRIBUTING.md) to
add an app.

Status: pre-alpha.

Appflare is an independent open-source project and is not affiliated with, endorsed by,
or sponsored by Cloudflare, Inc.

License: Apache-2.0.
