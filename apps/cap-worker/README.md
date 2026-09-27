# Cap Worker

[xyTom/cap-worker](https://github.com/xyTom/cap-worker) is a Cloudflare Worker backend
for [Cap](https://github.com/tiagozip/cap), a proof-of-work CAPTCHA: the browser
widget solves SHA-256 challenges, and your server checks the resulting token with the
Worker. No tracking and no third-party service.

## Notes

- **Using it.** Load `<install address>/cap.min.js` and set
  `data-cap-api-endpoint="<install address>/api/"` on the `<cap-widget>` element;
  validate tokens server-side with `POST <install address>/api/validate`.
- **The home page** is upstream's documentation page. Its live demo and code samples
  use upstream's public server (`captcha.gurl.eu.org`), not the install.
- **Open API.** Like upstream's, the API answers any origin. A valid token proves a
  challenge was solved, so validate each one once (the default) on your server.
- **Storage.** One SQLite Durable Object holds open challenges and issued tokens. An
  alarm prunes expired ones every minute, about 1,440 Durable Object requests a day.

The repository has no LICENSE file; its README states that the project is licensed
under MIT, which is what the entry shows. Upstream has no release tags; the entry
follows the default branch.
