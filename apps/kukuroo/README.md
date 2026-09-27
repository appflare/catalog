# Kukuroo

[Kukuroo](https://github.com/saiday/kukuroo) by Saiday is a Web Push service in one
Worker. Devices enroll on its page; anything that holds the send token notifies them
with one `POST /push/send`. It uses Declarative Web Push, so receiving needs Safari:
an iPhone or iPad on iOS 18.4 or later, or macOS Safari 18.5 or later. Licensed MIT.

## Notes

- **Keys.** The install form generates the VAPID private key (`KUKUROO_VAPID_PRIVATE`)
  and Appflare sets the matching public key (`KUKUROO_VAPID_PUBLIC`), which Kukuroo
  checks against the private key on every use. Keep a copy of the private key: a new
  key silently stops delivery to every device enrolled under the old one.
- **The enrollment address is permanent.** Devices keep the origin they enrolled on.
  If you want a custom domain, attach it before the first device enrolls.
- **Free plan.** A send fans out to every device in one invocation, so on the free
  plan one send reaches at most 50 devices; upstream measured about 20 as comfortable.
- **Build.** The Worker is upstream's standalone template, which installs the
  `kukuroo` package from npm (`^0.1.0`) and ships no lockfile; the resolved lockfile's
  hash is recorded in the manifest.
