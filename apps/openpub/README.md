# OpenPub

Self-hosted cross-posting engine for technical blogs.

Write one draft, publish it to dev.to, Hashnode, WordPress, Ghost, Medium,
Substack, GitHub Pages and your own site. Runs as a Worker in your own
Cloudflare account, with D1 for drafts and the publish log, KV for platform
credentials, R2 for cover images, a queue for publishes and Workers AI for
summaries.

Also ships a CLI (`openpub`) and an MCP server (`openpub-mcp`) so coding agents
can queue a publish.

## Install

Install OpenPub from the Appflare catalog. It provisions D1, KV, R2, the publish
queue and the Workers AI binding, then deploys the Worker and the dashboard.

## Configure

The API is `Authorization: Bearer <ADMIN_KEY>`, where `ADMIN_KEY` is generated
at install.

```sh
curl -X POST https://<your-host>/api/platforms/devto \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"api_key":"..."}'
```

## Publish

```sh
curl -X POST https://<your-host>/api/publish \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"content":"---\ntitle: Hello\n---\n\nBody","platforms":["devto","hashnode"]}'
```

## Notes

- Medium's API is deprecated upstream and Substack accepts drafts rather than
  live posts. Both adapters document their limits rather than hiding them.
- Upstream platform limits are documented in the repository README.

## Source

https://github.com/princepal9120/openpub
