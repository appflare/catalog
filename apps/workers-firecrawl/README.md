# Workers Firecrawl

[G4brym/workers-firecrawl](https://github.com/G4brym/workers-firecrawl) implements the
Firecrawl API on Cloudflare Browser Rendering, so the Firecrawl SDKs work against your own
Worker by changing their `apiUrl`. It has three endpoints: `/v1/search` searches the web
through DuckDuckGo and scrapes each result, `/v1/scrape` fetches one page, and `/v1/map`
lists the URLs of a site from its links and `sitemap.xml`. Results come back as Markdown,
cleaned or raw HTML, links, or screenshots. Licensed MIT.

## Notes

- **Browser Rendering.** On the free plan an account gets 10 minutes of browser time a day
  and 3 concurrent browsers; upstream's README predates that allowance and asks for
  Workers Paid. A busy integration will need Paid. Converting a large page to Markdown can
  also run past the free plan's CPU time per request.
- **API key.** Upstream leaves the API open when `AUTHORIZATION_KEY` is unset. Appflare
  generates one, since each open request would spend the account's browser time. The key
  guards every route, the OpenAPI docs page at `/` included.
- **Pin.** Upstream has no release tags, so the pin follows the default branch.
- No images: the repository publishes none.
