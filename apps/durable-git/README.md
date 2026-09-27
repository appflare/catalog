# dgit

[littledivy/durable-git](https://github.com/littledivy/durable-git) (dgit) is a git server in
which every repository is its own SQLite-backed Durable Object. It speaks git's smart HTTP
protocol to a stock git client (clone, fetch, shallow clones, push, forced updates) and
renders a cgit-style web interface: log, tree, blame, diffs, snapshots, atom feeds, and
about pages from the README. Pushed packs and cached full clones are kept in R2. Licensed
MIT.

## Before you install

- **Workers Paid.** A push or clone parses, hashes and builds packfiles in JavaScript, far
  beyond the free plan's 10 ms of CPU per request. Upstream's config also raises the CPU
  limit per request to five minutes (`limits.cpu_ms`), a paid-plan setting.
- **R2 enabled**, for the pack cache.

## Notes

- Reads of public repositories are open to anyone; pushes, admin calls and private
  repositories need the push token. Pushing to a new name creates the repository.
- One request is bounded by 128 MB of memory and five minutes of CPU, so upstream advises
  pushing a very large history in several parts.
- `GIT_TOKENS` adds tokens for more people; `MAX_PUSH_MB` caps one push; SHA-1 collision
  detection is off unless you turn it on.
- No images: the repository publishes none.
