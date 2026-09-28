# Run your own catalog

An Appflare manager reads the official catalog and any catalogs its admin adds
under **Settings > Catalogs**. A catalog of your own is a copy of this repository:
the same manifests, scripts and workflows, publishing your apps as GitHub Releases
and an `index.json` on your GitHub Pages site, with every artifact signed by your
key. Managers check everything from your catalog with your public key only, so
nobody else's key can stand in for yours and yours cannot stand in for the
official catalog's.

Everything in [CONTRIBUTING.md](CONTRIBUTING.md) applies to a copy too: how to add
an app, revisions, images, bumps and install checks. This page covers what is
different.

**Prebuilt releases only.** Managers install only `artifact` tier apps from a
catalog they added: "This catalog's index is not signed; only prebuilt releases are
installed from added catalogs." A release is signed with your key, but a
`sandbox` or `self-deploying` entry is trusted by what the index says, and an added
catalog's index is not signed yet. Managers leave such entries out of the catalog
page and refuse to install or update them. Signing the index is what would let
them in; until then, list artifact tier apps only.

## 1. Create the repository

Create a new repository from this one with **Use this template** on GitHub (or
fork it; a fork's scheduled workflows stay off until you enable them under
**Actions**). Pages needs a public repository, or a private one on GitHub Pro,
Team or Enterprise.

Then, in your copy:

- Delete the `apps/<slug>/` folders you do not want to carry and add your own
  (CONTRIBUTING.md, "Adding or updating an app"). Run `pnpm install` and
  `pnpm gen-codeowners` afterwards; the pull request checks refuse a stale
  `CODEOWNERS`.
- Leave `featured.json` as `[]`. Managers show a sponsored item only from the
  official catalog.
- Leave `index.json` to the workflows. The first publish run rebuilds it from
  your own releases.

## 2. Generate a signing key

The packer, `@appflare/pack`, is not on npm; the workflows build it from
`appflare/appflare` at the commit in `.appflare-ref`. Build it the same way on
your machine and run its `keygen` command:

```sh
git clone https://github.com/appflare/appflare.git
cd appflare
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@appflare/pack...
node packages/pack/bin/appflare-pack.js keygen \
  --out ~/appflare-catalog-signing.key --key-id yourname-2026-09
```

Pick a key id of lowercase letters, digits and dashes that names you and the
key's date. `keygen` writes the private key to the file (mode 0600), refuses to
overwrite a file or to write one inside a git working tree where it is not
ignored, and prints:

```
private key: /home/you/appflare-catalog-signing.key (mode 0600, base64 PKCS#8; not printed)
key id:      yourname-2026-09
public key:  {"keyId":"yourname-2026-09","publicKeyBase64":"..."}
fingerprint: SHA256:...
```

The `public key` line and the fingerprint are public. The private key file is the
one secret that lets anyone publish apps in your catalog's name: keep it out of
every repository, and keep a copy somewhere safe offline.

## 3. Configure the repository

Under **Settings > Secrets and variables > Actions**:

| Name | Kind | Value |
|---|---|---|
| `APPFLARE_SIGNING_KEY` | secret | The contents of the private key file |
| `APPFLARE_PUBLIC_KEY` | variable | The `public key` line `keygen` printed, exactly as printed |
| `CATALOG_PUSH_KEY` | secret | Private half of an SSH deploy key with write access on your repository; the workflows push `index.json` with it |
| `CLOUDFLARE_API_TOKEN` | secret | API token for a Cloudflare account kept for install checks (permissions in CONTRIBUTING.md, "Publishing") |
| `CLOUDFLARE_ACCOUNT_ID` | secret | That account's id |

`APPFLARE_PUBLIC_KEY` sets the key id the workflows sign with, and makes every
check in them verify with your key alone. Without it they sign with the official
catalog's key id and verify against the official keys, and your first publish
fails.

`APPFLARE_DEPLOY_KEY` is not needed: without it the workflows check out
`appflare/appflare` anonymously.

`DOCS_REBUILD_TOKEN` is not needed either: it starts the rebuild of appflare.dev,
which lists only the official catalog, and without it that step is skipped.

The install checks deploy each app into the Cloudflare account above, check that
it answers, and delete it again: in pull requests (`verify.yml`, whose `verify
passed` check fails without them) and every night (`nightly.yml`). Use an
account that runs nothing else.

Then make the repository settings in CONTRIBUTING.md, "Publishing": enable Pages
with source **GitHub Actions**, add the deploy key, and protect `main`.

## 4. Turn off what only the official catalog uses

- **Popularity.** Managers read GitHub stars and install counts only from the
  official catalog. Disable the `stats` workflow (**Actions > stats > ⋯ > Disable
  workflow**) or delete `.github/workflows/stats.yml`.
- **Sponsored slot.** Keep `featured.json` empty, as above.
- **Nightly install checks**, if you have no Cloudflare account for them: disable
  the `nightly` workflow. Your apps then never get a `lastVerified` time, so
  managers show no **Install checked** badge on them.
- **Tier checks.** `verify-tier.yml` checks sandbox and self-deploying entries,
  which managers do not install from an added catalog (see above). Disable it.

## 5. Publish

Push to `main`, or run **Actions > publish > Run workflow**. The workflow packs,
signs and releases every artifact tier app that has no release yet, rebuilds
`index.json`, and deploys the Pages site. Your index is then at:

```
https://<owner>.github.io/<repository>/index.json
```

with the owner in lower case (a repository named `<owner>.github.io` serves it
at `https://<owner>.github.io/index.json`). Publish at least one app before
anyone adds the catalog: when an admin adds it, Appflare checks the signature of
one released app with the key they pasted.

## 6. Tell people how to add it

Give admins two things:

- the index URL, and
- the `public key` line, which they paste into **Public key** in the **Add a
  catalog** dialog.

Also publish the key's fingerprint somewhere they already trust and that is not
the index itself: your website, your profile, or this repository's README. The
dialog shows the fingerprint of the pasted key back; an admin compares the two
before saving.

For how admins add, browse and remove catalogs, see
[Custom catalogs](https://appflare-docs.appflare-dev.workers.dev/guides/custom-catalogs/)
in the Appflare docs.
