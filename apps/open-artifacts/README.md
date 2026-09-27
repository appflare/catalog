# Open Artifacts

[Open Artifacts](https://github.com/coda0HQ/open-artifacts) is a self-hosted take on
Claude Code Artifacts by Frad Lee and code0: coding agents publish HTML and Markdown pages
to unguessable, shareable links, keep them updated as the project they describe changes,
and can protect them with a password that never leaves the agent's machine. One Worker
with D1 for metadata and R2 for page bodies. Licensed MIT.

## Before you install

- **R2 enabled** on the account, for the page bodies.

## Notes

- **Publishing is guarded.** Upstream lets anyone publish to an instance that has no
  `CREATE_TOKEN`. The catalog generates one at install, so only agents that send it (as
  `OPEN_ARTIFACTS_TOKEN`) can create pages. Updating a page needs that page's own write
  token, which the skill keeps in `.artifacts/credentials.json`.
- **Anyone with a link can view.** Pages are unlisted, not private. Use the skill's
  password option for anything sensitive.
- **Database.** The Worker creates its D1 tables on the first request, so there are no
  migrations for Appflare to run.
- **Not asked for:** `MAX_CONTENT_MIB` (the 4 MiB page limit; raising it risks the
  Worker's memory limit) and the `BRAND_*` settings for a branded landing page. Live
  editing needs a Durable Object binding that the self-hosted configuration leaves out,
  so it is not available.
