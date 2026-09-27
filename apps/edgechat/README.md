# EdgeChat

[EdgeChat](https://github.com/aozorae/Edgechat) by aozorae is team chat on Cloudflare
Workers: public and private groups, direct messages, realtime delivery over Durable
Objects, voice messages, attachments in R2, a Telegram bridge and an admin dashboard.
Licensed GPL-3.0. The interface speaks Chinese, English and Japanese.

## Notes

- **First admin.** Sign-up is by invite link only, so the install creates the first
  admin account from the user name and password in the install form, the way
  upstream's deploy script does. Appflare does not keep the password: copy it before
  you install. Updates never touch the account.
- **Encryption.** Message bodies and attachments are encrypted at rest with the
  encryption key from the install form (upstream's automatic key mode, key id
  `auto-v1`). Keep a copy of the key: without it, what it encrypted cannot be read.
- **Database.** `worker/schema.sql` creates the tables on install and adds any that
  are missing on update. Upstream's dated migrations in `worker/migrations` upgrade
  databases older than that schema and are not run.
- **R2.** Attachments, avatars and voice messages need R2 turned on in the account.
- **Message retention.** A daily cron trigger deletes messages older than
  "Keep messages for (days)", with their attachments; 7 by default, as upstream ships
  it. Raise it in the app's settings to keep history longer.
