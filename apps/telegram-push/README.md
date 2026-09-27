# Telegram Push

[telegram-push](https://github.com/sduoduo233/telegram-push) by sduoduo233 sends
notifications to Telegram from anything that can make an HTTP request. Your own bot
gives each private chat a push key; `GET /push?key=<push key>&msg=<text>` sends the
text to that chat. The repository has no licence file.

## After you install

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Open `/install` on the app right away and enter the token. The app checks it, points
   the bot's webhook at itself, and locks the page. Until then anyone who finds the
   address can set a bot of their own.
3. Message your bot `/new` to get a push key.

## Notes

- **The bot is open.** Anyone who finds your bot in Telegram can ask it for a push key
  and send messages to their own chat through your Worker. Keys only reach the chat
  that asked for them.
- **Changing the bot.** The token lives in the app's KV namespace, not in its settings;
  to use another bot, delete the key `INSTALL` there and open `/install` again.
- **Messages** are sent with Telegram's Markdown parse mode, so `*`, `_` and backticks
  format the text.
- **Updates.** Upstream publishes no tags and has not changed since July 2023; the entry
  follows its default branch, `next`.
