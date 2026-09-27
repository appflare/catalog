# Media for ShotSync

Upstream: [`Defiabell/shotsync`](https://github.com/Defiabell/shotsync) at the pinned v1.0.0 commit [`39c024a4d93095b5cddfbe4ad9950a37d7e319a4`](https://github.com/Defiabell/shotsync/tree/39c024a4d93095b5cddfbe4ad9950a37d7e319a4), licensed [MIT](https://github.com/Defiabell/shotsync/blob/39c024a4d93095b5cddfbe4ad9950a37d7e319a4/LICENSE).

- `icon.svg`: [`src/gallery/page.ts`](https://github.com/Defiabell/shotsync/blob/5165cd51791f1790fbaf2c1b4410805db831d926/src/gallery/page.ts#L55) at the newer commit `5165cd5`, a generic picture glyph used as the self-hosted app's inline SVG favicon. It postdates the pinned release, whose `page.ts` has no favicon. Decoded from its URL-encoded data URI; SVG drawing unchanged.
- `screenshots/01-gallery.png`: [`docs/screenshot.png`](https://github.com/Defiabell/shotsync/blob/39c024a4d93095b5cddfbe4ad9950a37d7e319a4/docs/screenshot.png), referenced in the [pinned README](https://github.com/Defiabell/shotsync/blob/39c024a4d93095b5cddfbe4ad9950a37d7e319a4/README.md#L49). Byte-identical to the file at the pinned commit.
- `cover.png`: [`docs/social-preview.png`](https://github.com/Defiabell/shotsync/blob/5bff5d996e49740bca07ff08c0ca9c8b48deb0a7/docs/social-preview.png) at the newer commit `5bff5d9`, the project's social preview, added after the pinned release. Scaled from 1280x640 to 1260x630, then trimmed 30 px of empty margin from each side to 1200x630; no visible content removed.

Left out: `demo/assets/*.jpg` are sample gallery content, not screenshots of the app interface. The hosted service's separate two-arrow icon in `src/hosted/mobile-icons.ts` belongs to the hosted variant, not this self-hosted entry.
