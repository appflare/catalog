# FeedLog

[FeedLog](https://feedlog.ai) is a feedback and roadmap tool by LinkCraft Studio:
feedback boards with voting, a public roadmap, a changelog that AI can draft for you,
and a widget to embed in your own product. It is a Nuxt app that runs on Workers,
keeps uploads in R2, and stores everything else in PostgreSQL. Licensed MIT.

## Before you install

- **A PostgreSQL 17+ database** reachable from the internet, with the `vector`
  extension enabled (`CREATE EXTENSION IF NOT EXISTS vector;`; Neon and Supabase have
  a switch for it). The install form asks for its connection string, and Appflare
  creates a Hyperdrive configuration from it. The string is sent to Cloudflare once
  and not stored by Appflare.
- **R2 enabled**, for uploaded images.

## Notes

- **Tables.** The Worker carries its Drizzle migrations. On the first visit it
  finds the empty database and runs them from its `/setup` page. After an update
  that adds migrations, an admin opens `/setup` to apply them; visitors who are not
  signed in cannot start a schema change.
- **The first admin** is the first sign-up with an address listed in **Admin
  emails**. Set it before anyone signs up.
- **Sign-in.** Email and password until Google or GitHub OAuth is set up; from then
  on, sign-in is through OAuth only.
- **AI features** (similar-idea detection, changelog drafts) need an
  OpenAI-compatible API key; the rest of the app works without one.
- **Mail** (password reset, verification) needs Resend; without it, mail is only
  logged.
