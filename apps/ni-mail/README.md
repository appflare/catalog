# ni-mail

[ni-mail](https://github.com/mskatoni/ni-mail) by mskatoni receives mail for your own
domain and serves it over an HTTP API, for scripts that wait for a sign-up code or a
notification. Each address gets its own mailbox in a SQLite-backed Durable Object, with
threads, read state and attachments in R2. There is no web page. Licensed Apache-2.0.

## Before you install

- **A domain on Cloudflare DNS**, with Email Routing available. The install turns Email
  Routing on for the zone you pick and points its catch-all rule at the app, and refuses
  when the catch-all already sends mail somewhere else.
- **Mail domains** must name that zone. Mail to a domain not listed is refused.

## Using the API

Every request except `/health` needs the access key in an `X-Auth-Key` header.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/mailboxes/<address>/latest` | the newest message |
| GET | `/api/mailboxes/<address>/emails` | the mailbox's messages |
| GET | `/api/mailboxes/<address>/emails/<id>` | one message, with text and HTML |
| GET | `/api/mailboxes/<address>/threads/<id>` | a thread |
| DELETE | `/api/mailboxes/<address>/emails` | empty the mailbox |
| GET | `/latest`, `/mails`, `/mail/<id>` | the same for the default mailbox, or `?mailbox=` |

## Notes

- **Sending is off.** Upstream's send, reply and forward routes need a `send_email`
  binding its config does not declare, so they answer with an error here.
- **Upstream's README** still describes the older KV version; the routes above are the
  current Worker's.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
