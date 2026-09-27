# ternssh

[ternssh](https://github.com/haradakashiwa/ternssh) by haradakashiwa is an SSH
workspace on Workers: a dashboard of draggable panels with terminals, SFTP with an
editor, network, process and server status monitors, quick commands, saved servers,
passwords and keys, and an AI helper that turns a request into a shell command with
your own API settings. SSH connections run in a Durable Object over Workers'
outbound TCP sockets. Licensed GPL-3.0-or-later.

## Notes

- **Sign-in.** Until someone sets a username and password on the first visit, the
  app asks the visitor to set them, so open it right after the install. After that
  every request needs them; three failed attempts lock the IP address out for an
  hour. With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, it trusts Cloudflare Access
  sign-in instead.
- **Build.** Upstream's root `postinstall` installs `web/` and `server/`; install
  scripts do not run here, so both are installed from their own lockfiles, then the
  web app is built into `server/public`.
