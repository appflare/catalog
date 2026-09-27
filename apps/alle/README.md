# Alle

[Alle](https://github.com/bestruirui/Alle) by BESTRUI gathers your mail into one inbox.
Turn on automatic forwarding in each mailbox you have (Gmail, Outlook, QQ Mail and
others) to an address on a domain in your Cloudflare account; Email Routing hands every
message to the Worker, which files it under the mailbox it came from, keeps it in D1 and
its attachments in R2, and shows everything in one React app behind a single password.
Mail sent straight to any other address of the domain shows up too, so throwaway
addresses need no setup. The repository has no licence.

## Before you install

- **A zone in the account** with Email Routing available. The install sends the zone's
  catch-all to the app, and refuses when the catch-all already sends mail somewhere else.
- **R2 enabled** on the account, for attachments.

## Notes

- **Password.** `SECRET` is generated: it is the only sign-in password and also signs the
  sign-in cookie, so a new value signs you out everywhere.
- **Accounts.** Alle creates an account the first time mail arrives for an address it has
  not seen.
- **Version.** This is upstream's default branch, `v2`, built on Vite, React and Hono.
  Its README still describes AI code extraction, which this branch does not have.
- **Updates.** Upstream publishes no tags, so the entry follows `v2`.
