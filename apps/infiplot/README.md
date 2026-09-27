# InfiPlot

[InfiPlot](https://infiplot.com) by Zonghao Yuan is an interactive story game whose
content is generated while you play: a text model directs the plot and dialogue, an
image model paints each scene, a vision model reads what you click in the picture, and
an optional speech model gives each character a voice. Stories are saved in the
browser and can be shared as `.infiplot` files. Licensed AGPL-3.0.

## Before you install

- **Workers Paid.** Upstream states that the scene pipeline needs more CPU time than
  the Workers Free plan allows.
- **Three AI providers.** A text endpoint, an image endpoint and a vision endpoint,
  each with a key; any OpenAI-compatible text and vision endpoint works, and images
  come from Runware or an OpenAI-compatible image API. The defaults are upstream's
  suggestions (DeepSeek, Runware's FLUX.2 [klein], Xiaomi MiMo). Speech is optional.
- **Access control.** The game has no sign-in in this build, and every scene is paid
  for with your keys. Put it behind Cloudflare Access before you share the address.

## Notes

- **Build-time options are off.** Upstream's Supabase sign-in, Umami analytics and
  image proxy are turned on by `NEXT_PUBLIC_` variables that Next.js writes into the
  build, so they cannot be set after install.
- **Players' own keys.** Players can enter their own OpenAI, Claude or Gemini key, or
  their own Xiaomi speech key, in the game's settings; those calls then use the
  player's key instead of yours.
- **Costs.** The engine pre-generates scenes you might choose, so provider spend runs
  somewhat above the scenes you see. Setting **Scene images** to placeholders in the
  app's settings skips the image model while you try things out.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
