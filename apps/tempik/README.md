# Tempik

[Tempik](https://github.com/hirotomasato/tempik) by Hiroto Masato is a disposable email
service on your own domain. Email Routing hands every message sent to the domain to the
Worker, which stores it in D1; the web page lets a visitor pick or generate an address
and read what arrives. Licensed MIT.

## Before you install

- **A domain on Cloudflare DNS**, with Email Routing available. The install turns Email
  Routing on for the zone you pick and points its catch-all rule at the app, and refuses
  when the catch-all already sends mail somewhere else.
- **A domain kept for throwaway mail.** Tempik has no sign-in. Anyone who can open the
  app can claim any address of the domain, including one already in use, and read its
  mail.

## Notes

- **Storage.** Messages stay in D1 until the database is emptied by hand; upstream has no
  cleanup job.
- **Web address.** Upstream serves the page on a custom domain of the same zone
  (`tempik.<domain>`); the install serves it at the Worker's address, and a custom
  domain can be added afterwards.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
