# mail2telegram

[TBXark/mail2telegram](https://github.com/TBXark/mail2telegram) receives the email
of one of your domains in Telegram. Every message arrives as a chat message with
Preview, Summary, and Open buttons, and a Telegram Mini App keeps the full inbox:
folders, search, attachments, allow and block lists, forwarding, and AI summaries
with Workers AI or any OpenAI-compatible provider. Replying from Telegram goes
through Resend.

The install creates the D1 database (with upstream's migrations), the R2 bucket for
attachments, and a daily cleanup cron, and asks for a zone: Email Routing is turned
on there if it is off, and the zone's catch-all rule sends every address without
another rule to the Worker. It asks for the Telegram bot token and the chats to
push to, and generates a password for opening the Mini App outside Telegram.

Everything fits the free plan. Parsing a message costs about 2 ms of CPU per MB,
so on the free plan's 10 ms keep the Max Size setting under about 2 MB.

Pinned to upstream release tags.
