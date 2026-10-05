# CloudSSH

[newbietan/CloudSSH](https://github.com/newbietan/CloudSSH) is a web SSH client whose
SSH-2.0 stack is written in TypeScript and runs in a Durable Object, connecting to
your servers over Workers' outbound TCP sockets. It has multiple terminal tabs, SFTP
with an editor, jump hosts, saved servers, command snippets, audited one-time sharing,
host-key checks, and an AI assistant that uses your own OpenAI-compatible API key.

The install creates three Durable Object classes: sessions, per-user data, and
shares. It requires sign-in by default, so the Worker cannot be used by strangers to
open SSH connections: set an admin password hash, made on the app's own setup page,
or a GitHub OAuth app in the settings.

CloudSSH is licensed under Apache-2.0. Upstream has no release tags, so the pin
follows main.
