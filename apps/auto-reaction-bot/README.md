# Auto Reaction Bot

[Malith-Rukshan/Auto-Reaction-Bot](https://github.com/Malith-Rukshan/Auto-Reaction-Bot)
by Malith Rukshan is a Telegram bot that reacts to messages with a random emoji from
your list: every private message, posts in channels it administers, and group messages
(all of them, or fewer as the randomness setting goes up). Licensed MIT.

## Notes

- **Setup order.** Create the bot with @BotFather, install with its token and username,
  then point the bot's webhook at the Worker with Telegram's `setWebhook` (the link is
  on the app's page). Without the webhook the bot receives nothing.
- **Webhook secret.** Upstream does not check Telegram's webhook secret token, so the
  Worker accepts any request as an update. Someone who learns the address could make
  the bot react or reply in chats it is already in. Keep the address to yourself.
- **Replies.** `/start` answers with upstream's welcome text and buttons, including a
  link to upstream's own bot for donations; `/reactions` lists the emojis; `/donate`
  sends a Telegram Stars invoice for your bot.
- **Emojis.** Telegram accepts only its own set of reaction emojis and refuses a
  reaction with any other.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
