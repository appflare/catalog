# DictDeck

[DictDeck](https://github.com/Asutorufa/hujiang_dictionary) is a dictionary, translator
and vocabulary flashcard app by Asutorufa, written in Rust for Cloudflare Workers. It
looks words up in several sources (Hujiang, Weblio, Kotobank, English and Korean
dictionaries, Google Translate), explains them with Workers AI or an LLM provider you
add, and keeps saved words as review cards. The repository has no licence file.

## Before you install

- **Workers AI** is on for the account; the AI binding explains and translates.

## Notes

- **Sign-in.** The web app asks for the user name and password from the install form.
  The Worker lets every request through while either is empty, so both are required
  here. `AUTH_SECRET` signs the sign-in tokens.
- **Database.** The Worker creates its D1 tables itself on first use.
- **Telegram bot.** Optional: add the bot token, your Telegram user id as maintainer
  and any other allowed users under Settings, then register the webhook by calling
  `/tgbot/register` on the app while signed in. The webhook at `/tgbot` does not check
  Telegram's secret token, so anyone who knows the address and an allowed user's id
  can send it updates in that user's name.
- **Schedule.** A cron trigger every 20 minutes from 00:00 to 15:59 UTC sends review
  cards through the bot; it does nothing until a bot is set up.
- **MCP.** `/mcp` is a Streamable HTTP MCP server. Create a token with
  `dictionary:read` or `dictionary:write` under Settings and send it as a Bearer token.
- **Build.** Catalog CI installs Rust with the `wasm32-unknown-unknown` target, then
  `worker-build` 0.8.6, builds the web app in `web/` (served as static assets), and
  runs the wrangler config's own `worker-build --release` in `worker/`.
- **Images.** None: the repository has no licence that covers its logo or screenshots.
