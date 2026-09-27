# Auth Inbox

[Auth Inbox](https://github.com/TooonyChen/AuthInbox) is a self-hosted inbox for
verification mail by Tony Chen. Email Routing delivers every address of a domain to the
Worker; promotional mail is recognised by its headers and stored as it is, and the rest
goes to an AI model you choose, which pulls out the code or link and the sender and
sorts the mail into categories such as login code or password reset. A React dashboard
shows the results. The admin creates users and grants each one the addresses and
categories they may read, and a remote MCP server gives AI agents the same view,
including a tool that waits for the next code. Licensed MIT.

## Before you install

- **A zone in this account** for the addresses you hand out. The install turns Email
  Routing on for it and points its catch-all at the Worker.
- **An AI provider API key.** Any OpenAI-compatible API (Gemini, OpenAI, DeepSeek, Groq,
  and others) or Anthropic's.

## Notes

- **The API keys are secrets.** Upstream's wrangler config sets `AI_API_KEY` among its
  vars to a placeholder; here it is a Worker secret, and that var is left out. The
  optional fallback key is a secret too.
- **First admin.** While no account exists, the sign-in page offers to create the first
  admin to whoever opens it. Do that right after the install.
- **MCP.** Agents connect to `/mcp` with API keys created in the dashboard. Upstream's
  OAuth flow for claude.ai connectors needs a KV namespace its config leaves commented
  out, so it is off here.
- **Bark.** iOS push notifications through Bark are off unless you turn them on and add
  your device tokens.
- **Versions.** Upstream has no releases; the entry follows the default branch.
