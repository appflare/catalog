# Jina AI MCP Server

[jina-ai/MCP](https://github.com/jina-ai/MCP) is the source of Jina AI's hosted remote
MCP server at mcp.jina.ai. An install serves the same tools from your own Worker at
`/v1` (and `/sse` for older clients): read a URL or PDF as Markdown, capture a
screenshot, search the web, arXiv, SSRN and images, rerank documents and deduplicate
strings, all through Jina's APIs. Licensed Apache-2.0.

## Notes

- **API key.** Each client should send its own Jina key as a Bearer token. The optional
  `JINA_API_KEY` setting is used for any request without one, so leave it unset unless
  the Worker's address stays private: anyone who can reach it would spend your key.
- **Tool filters.** `?include_tags=`, `?exclude_tags=`, `?include_tools=` and
  `?exclude_tools=` on the `/v1` URL trim the tools a client sees.
- **Jina blog search.** `search_jina_blog` reads Jina's blog through a key only the
  hosted server has, so it answers with an error on an install.
- **Pin.** Upstream has no release tags, so the pin follows the default branch.
- No images: the README's screenshots show third-party MCP clients, not the server.
