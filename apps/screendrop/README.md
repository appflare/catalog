# Screendrop Cloud

[Screendrop Worker](https://github.com/fayazara/screendrop-worker) by Fayaz Ahmed is the
cloud backend of [Screendrop](https://github.com/fayazara/screendrop), a macOS screenshot
and screen recording app. The app uploads each capture here and gets a share link back:
screenshots open in a viewer, recordings in a share page with a player, a transcript,
captions, scrub previews, comments and likes. Captures are stored in R2, their metadata
in D1.

## Notes

- **Upload token.** The Screendrop app generates the token under Settings, Cloud. Paste
  it into the install form, then give the app the Worker's address. Anyone with the
  token can upload to and delete from your instance.
- **Comments and likes** need a signed-in viewer, through a GitHub OAuth app, a Google
  OAuth client, or both. Without either, share pages show neither.
- **Session key.** `AUTH_SECRET` is generated so viewer sessions do not depend on the
  upload token. Upstream falls back to the upload token when it is unset.
- **Database.** The six Drizzle migrations in `drizzle/` run on install and update.
  The Worker's `/api/setup`, which the app calls on Verify Connection, creates the same
  tables with `IF NOT EXISTS`, so it finds them in place.
- **Licence.** The repository has no LICENSE file; its README's License section says
  MIT.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
