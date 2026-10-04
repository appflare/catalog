# Seeder

[Seeder](https://seederpm.xyz) by Daniel Syauqi and Thaqif Rosdi is a project manager
for small teams: kanban boards with phases and priorities, a queue of client requests, a
token-gated read-only board to share with clients, a daily planner, an activity feed,
and a built-in MCP server. Built with Next.js, running on Workers with D1 and R2.
Licensed MIT; the Seeder name and logo are the authors' trademarks.

## Before you install

- **R2 enabled**, for uploaded images and files.

## Notes

- **Encryption key.** The Git integration's key, 32 random bytes in base64, is generated
  at install. The app does not start without it.
- **First owner.** Only the owner email can create the first account at `/sign-in`;
  after that, people join by invite.
- **App URL.** `BETTER_AUTH_URL` is filled in with the workers.dev address. After adding
  a custom domain, set it to the domain and list the workers.dev address under other
  allowed origins.
- **CPU limit.** Upstream's wrangler config sets `limits.cpu_ms` to 30000, the paid
  plan's default; the artifact carries it as it is.
- **Google sign-in** turns on when both Google secrets are set.
