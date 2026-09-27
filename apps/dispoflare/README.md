# Dispoflare

[Dispoflare](https://github.com/LeoColomb/dispoflare) by Léo Colombaro makes disposable
addresses on your own domains, an alternative to Firefox Relay. Each address is an Email
Routing rule that forwards to one of your verified destination addresses until its
expiry date; twice a day a cron trigger turns expired addresses off, and deletes them a
month later when you asked for that. Licensed MIT.

## Notes

- **No sign-in.** Upstream expects Cloudflare Access in front of the app. Turn it on
  for the Worker's workers.dev address (or custom domain) before using it; until then
  anyone with the address can see your destination addresses and add or remove
  forwarding addresses.
- **Its own token.** The app calls the Cloudflare API with `CLOUDFLARE_API_TOKEN`, a
  token you create with Email Routing Addresses Read (account), Email Routing Rules
  Edit, Zone Read and Zone Settings Read. `CLOUDFLARE_ACCOUNT_ID` is filled in with the
  account the app is installed in.
- **One per account.** The cron job acts on every Dispoflare rule the token can see and
  points deprecated addresses at the Worker named `dispoflare`, so the entry keeps that
  name.
- **Email Routing** must be on for each domain you want addresses on, with your inbox
  verified under Destination addresses. Appflare does not change the zone's routing; the
  app adds one rule per address.
- **Settings page.** Unfinished upstream; its values are not saved.
- **Images.** None: the favicon and the README illustration draw Cloudflare's own
  product icons.
- **Updates.** The entry follows upstream's release tags.
