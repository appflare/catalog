# Playwright MCP

[Playwright MCP](https://github.com/cloudflare/playwright-mcp) is Cloudflare's fork of
Microsoft's Playwright MCP server, running on Workers with
[Browser Rendering](https://developers.cloudflare.com/browser-rendering/). This entry
installs the repository's deployable server (`cloudflare/example`). Licensed
Apache-2.0.

## Notes

- **Endpoints.** `/mcp` speaks Streamable HTTP and `/sse` speaks SSE; every other path
  answers 404. Clients that only run local servers, such as older Claude Desktop
  builds, can reach it through `npx mcp-remote <your address>/sse`.
- **Browser time.** Each session opens a browser from Browser Rendering in your
  account. The Workers Free plan allows 10 minutes of browser time a day and 3
  browsers at once; Workers Paid allows more and bills by use.
- **No sign-in.** The server does not check who is calling. Keep its address to
  yourself, or put Cloudflare Access in front of it if your MCP client can send
  Access credentials.
- **Pin.** The entry follows the head of `main`: the example at the `v0.0.5` tag still
  installs the 0.0.4 library, and the commits after the tag move it to 0.0.5.
