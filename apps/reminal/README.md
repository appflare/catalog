# Reminal

[Reminal](https://github.com/harshalgajjar/Reminal) by Harshal Gajjar puts the
terminals, app windows and desktops of your machines in any browser. The `reminal`
program on each machine and every viewer dial out to a relay; this entry installs
that relay (the repository's `cloudflare/` Worker) in your account instead of using
the public one. Licensed AGPL-3.0; upstream also sells commercial licences, which
running it unmodified does not need.

## What the relay exposes

- **Sessions, end-to-end encrypted.** The relay routes ciphertext between a machine
  and its viewers. It has no accounts: a session is reachable only with the session ID
  and PIN the machine prints, or from a device you enrolled as an owner on that
  machine (`reminal own`, then `sudo reminal add owner <id>`). Window and desktop
  frames go peer-to-peer over WebRTC and do not pass through it.
- **Port forwards.** `reminal expose` serves a web port of your machine at
  `/p/<id>/` on the relay, behind the session PIN. That traffic is not end-to-end
  encrypted: it passes through your Worker in the clear. Upstream's public relay also
  serves these on `port-<id>` subdomains; that needs a wildcard route, which this
  install does not add.
- **Alerts.** Off until you set `VAPID_PRIVATE_JWK` (a JWK) and the matching
  `VAPID_PUBLIC`. Appflare cannot generate the key, since the relay reads it as a
  JWK rather than a bare key.

## Notes

- Point the program at your relay with `REMINAL_WEB=<your relay URL>`, or build it
  with your URL as the default (`reminal.build.env`, see upstream's
  `cloudflare/README.md`).
- Upstream's `public/_headers` (`Cache-Control: no-store` for every asset) is not part
  of the artifact, so the viewer's files use the default caching.
