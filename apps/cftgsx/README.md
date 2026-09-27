# cftgsx

[SCSHIRKER/cftgsx](https://github.com/SCSHIRKER/cftgsx) is a Telegram contact bot on one
Worker. Whatever people send the bot is forwarded to one admin chat, and the admin's
replies go back to the sender, so you can be reached without sharing your own account.
Licensed MIT. The bot's messages are in Chinese.

## Notes

- **Setup.** After installing, open `/setWebhook` on the Worker once to point the bot at
  it. The webhook secret is generated at install, and the bot refuses updates that do
  not carry it.
- **Storage.** Upstream's config keeps the KV namespace commented out; this entry adds
  it, so bans, the user list, broadcasts to everyone and forum mode work. With user
  tracking and forum mode off, only bans are stored.
- **Forum mode** gives each user a topic of their own in the admin group and asks new
  users a small sum before their first message is forwarded. The admin chat must be a
  group with topics, and the bot an admin in it.
- **Health check.** The Worker answers 500 on every path until `BOT_TOKEN` and
  `ADMIN_CHAT_ID` look like a real token and chat id, so the entry counts any answer of
  the Worker as healthy.
- **Pin.** The pin follows the default branch rather than the v1.2.0 tag, for the
  Markdown escaping fixes and the ban commands added since. The bump bot moves it to
  the next release tag.
- No images: the repository has none.
