# ChatGPT Telegram Bot

[TBXark/ChatGPT-Telegram-Workers](https://github.com/TBXark/ChatGPT-Telegram-Workers)
runs a Telegram chat bot on Workers. It talks to OpenAI, Anthropic, Workers AI, or any
OpenAI-compatible endpoint, and keeps chat history and its settings in a KV namespace
that is created at install.

The install asks for the bot token from @BotFather and your Telegram user id. AI
providers, allowed users and groups, prompts, and plugins are set later in the bot's
admin panel, not at install. Sign in there once with the generated admin password
and open `/init` to register the webhook; after that `/admin` in Telegram opens the
panel directly.

One Worker serves one bot. Pinned to upstream release tags.
