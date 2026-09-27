# Folia

[Folia](https://github.com/chthollyphile/folia-major) by chthollyphile is a music player
built around full-screen lyrics: several animated lyric modes, automatic lyric and cover
matching, and AI colour themes per song. This entry installs its web version, served by
one Worker. Licensed AGPL-3.0.

## What works

- **Local music.** Import a folder in the browser; Folia keeps an index and reads the
  files from your device. Lyric files next to the songs (`.lrc`, `.ttml` and others) are
  picked up.
- **Navidrome.** Connect your own Navidrome server in the settings.
- **AI themes and lyric segmentation** with a Gemini API key, set as `GEMINI_API_KEY`.
  Without it those features are off.

## What does not

The NetEase Cloud Music, KuGou and QQ Music sources read their API addresses from Vite
variables (`VITE_NETEASE_API_BASE`, `VITE_KUGOU_API_BASE`, `VITE_QQ_API_BASE`) that are
compiled into the web app at build time. This build sets none of them, so those sources
are unavailable, and AI themes cannot use the OpenAI-compatible provider, which is also
chosen at build time. Upstream's Vercel and Docker deployments set them per site.

## Notes

- **Sync server.** Upstream's optional sync server, which syncs themes between devices, is
  a separate Worker with its own D1 database and is not part of this entry.
- **Updates.** The entry follows upstream's release tags.
