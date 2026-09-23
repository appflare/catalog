# Second Brain

[rahilp/second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare)
gives AI assistants a shared long-term memory. It is an MCP server: Claude, ChatGPT,
Codex, and other MCP clients save notes to it and recall them later by meaning, not
only by keyword. Memories live in a D1 database, their embeddings in a Vectorize
index, and Workers AI computes the embeddings and tags new memories. A dashboard at
the Worker's address lets you browse and edit them, and a nightly job links related
memories and condenses old ones.

The install creates the D1 database, the Vectorize index (384 dimensions, cosine),
and a KV namespace for OAuth grants and settings, and asks for one secret: the auth
token that signs you in to the dashboard and to every MCP client. The app creates
its own tables on its first request.

Everything fits the free plan for personal use. Vectorize's free tier stores about
13,000 vectors of this size, and Workers AI allows 10,000 Neurons a day; beyond that
the account needs Workers Paid.

Pinned to upstream release tags.
