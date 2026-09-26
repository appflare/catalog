# Punctual

[CCCrafts/punctual](https://github.com/CCCrafts/punctual) is a scheduling app in the
style of Calendly: booking pages for event types, busy times read from Google Calendar
or Microsoft 365, collective and round-robin team events, reminders, reschedule and
cancel links, intake questions, and webhooks.

The install creates the D1 database (with upstream's migrations), a KV namespace for
cached busy times and social cards, an R2 bucket for avatars and logos, two Durable
Objects, a queue with a dead-letter queue for email and webhooks, and a cron that runs
every five minutes for reminders. It generates the two keys and asks for the public
URL. Email (Resend or Brevo) and calendar connections (your own Google and Microsoft
OAuth apps) are optional settings; without an email provider, sign-in links go to the
Worker's logs.

Punctual is licensed under MIT. Pinned to upstream release tags; new releases merge on
their own once the install check passes.
