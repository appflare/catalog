# scrapedown

[ozanvos/scrapedown](https://github.com/ozanvos/scrapedown) fetches a web page, keeps
its article with Mozilla Readability, and returns it as Markdown (or cleaned HTML and
plain text) with the title, byline, excerpt, site name and language, as JSON. Licensed
MIT.

## Notes

- **Open endpoint.** Upstream has no access key, so anyone who knows the Worker's
  address can use it to fetch pages. Keep the address private or put the Worker behind
  Cloudflare Access; each use counts toward your Workers requests.
- **Fetching.** The Worker fetches pages with a Googlebot user agent, as upstream does.
  Some sites answer that differently from a browser or refuse it, and pages that need
  JavaScript to show their text come back empty.
- **Pin.** Upstream has no release tags and no commits since January 2024; the pin is
  the head of the default branch.
- No images: the README's illustration is not a logo or a screenshot of the app.
