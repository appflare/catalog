# elm.chat

[elm.chat](https://github.com/shawnbure/elm-chat) is an account-free chat by Shawn Bure
for conversations that should not last. A room is created with its own rules (how long
each message stays, how long the room lives when idle), invites are single-use links,
messages and files are end-to-end encrypted in the browser, and the room secret stays in
the link's fragment, so the server never sees it. One Worker serves the web app and the
API; each room is a SQLite-backed Durable Object that is wiped when the room ends.
Licensed AGPL-3.0.

## Notes

- **Open to anyone who has the address.** There are no accounts: anyone who reaches the
  Worker can create rooms. Upstream's [abuse policy](https://github.com/shawnbure/elm-chat/blob/e415766d2b246f7c248f55f065060bad7fa79bd9/docs/abuse-policy.md)
  makes the operator of an instance responsible for it.
- **No bot check.** Upstream's optional Turnstile check needs a site key compiled into
  the web app, which a catalog build does not have, so it is off.
- **No analytics.** The hosted elm.chat records aggregate growth events to Analytics
  Engine; the configuration this entry installs (upstream's Deploy to Cloudflare
  template) has no such dataset, so nothing is recorded or sent anywhere.
- **Early stage.** Upstream describes the project as early-stage and not independently
  audited.
