# placeholders.dev

[Cherry/placeholders.dev](https://github.com/Cherry/placeholders.dev) generates SVG
placeholder images from the URL: size, text, font, colours, dark-mode colours and text
wrapping. This install serves them under `/api` (for example `/api/350x150`) next to the
project's homepage. Licensed MIT.

## Notes

- The public service answers on its own `images.placeholders.dev` host; an install uses
  the `/api` path instead, as upstream's development setup does. The homepage's examples
  still load from the public host.
- Upstream's production environment also writes request analytics to Analytics Engine; the
  installed Worker does not, and needs no storage at all.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
