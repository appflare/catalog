# 888wiki

[888wiki](https://github.com/tbdavid2019/888wiki) by DAVID888 is a Markdown-first
notepad and wiki. Write in Markdown, or in Block, Canvas and Whiteboard editors; publish
notes as shares with a password, a scheduled unlock, a view limit or an expiry; and
present a note as slides or a book. Licensed AGPL-3.0.

## Notes

- **Open by default.** Anyone who can reach the Worker can create notes at random short
  paths. Put a password on a note to keep it private, or put the Worker behind
  Cloudflare Access.
- **Storage.** Notes and shares live in the two KV namespaces; note history, view
  counts and paragraph annotations in D1; uploaded images in the R2 bucket. The three
  D1 schema files in `schema/` run on every install and update, as upstream's own
  deploy runs them, and only create what is missing.
- **Secrets.** The admin password, the password salt and the session secret are
  generated. A new salt makes existing note passwords stop working; a new session
  secret signs everyone out.
- **AI.** A Groq API key turns on AI writing and audio transcription. Upstream's
  optional Workers AI fallback needs an `AI` binding its config leaves commented out,
  so it is off here.
- **Outside services.** Published audio and large attachments go to the author's
  888box attachment service; notes and images stay in your account. WebTalk and
  Google Analytics stay off unless you set their variables.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
