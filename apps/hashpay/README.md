# HashPay

[HashPay](https://github.com/TGDash/HashPay) by TGDash is a crypto payment gateway run
from your own Telegram bot. Merchants create orders through a signed REST API or inline in
Telegram; buyers pay USDT, USDC or the native coin on TRON, Ethereum, Base, BNB Chain,
Polygon, TON, Aptos or Solana, or through Binance, OKX or OKPay. A cron job checks pending
payments every minute and a queue delivers merchant callbacks. The Vue admin console opens
in a browser or as a Telegram Mini App. Licensed Apache-2.0.

## Before you install

- **A Telegram bot.** Create one with @BotFather and have its token ready.

## Notes

- **Setup.** Open the app right after installing, enter its address as the site domain
  (this sets the bot's webhook), then message the bot: the first Telegram account to do so
  becomes the admin.
- **Secrets.** `APP_SECRET` is generated and signs admin sessions; a new value signs
  everyone out. Merchant key pairs are created in the admin console, which shows each
  private key once.
- **Database.** The two D1 migrations run on install and update. The Worker also applies
  them itself, under the same names in `d1_migrations`, so neither side runs one twice.
- **Cron trigger.** One, every minute. The Workers Free plan allows 5 per account.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
