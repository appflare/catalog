# Collection Down

[Collection Down](https://github.com/heartalborada-del/Collection-Down) by heartalborada
is a downloader for Bilibili's digital collections (收藏集) and decoration suits. Search
a collection or paste a share link, browse its cards, videos and emoji packs, and
download them; downloads are assembled in the browser. It is a Nuxt app built with
Nitro's cloudflare-module preset. Licensed MIT.

## Notes

- **What the Worker does.** It calls Bilibili's public API, answering its
  proof-of-work challenge as a browser would, and relays media only from Bilibili's own
  image and video hosts, so the browser can download them. It stores nothing.
- **Public.** There is no sign-in; anyone who finds the address can use it.
- **Build.** Classic yarn, pinned by upstream to 1.22.22. The wrangler config's `main`
  and `assets` read Nitro's `.output/`. One dependency resolves from the author's own
  npm registry, as `.npmrc` says; the lockfile pins its URL and integrity hash.
- **Updates.** The entry follows upstream's release tags.
