# blobatar API

[blobatar](https://github.com/Alain00/blobatar) by Alain renders a deterministic
geometric avatar from any string. This entry installs the repository's HTTP endpoint
(`apps/api`), the same one blobatar.dev serves, on a Worker of your own. Licensed MIT.

## Notes

- **Routes.** `GET /avatar/<name>` returns an SVG; parameters follow the library
  (`size` or `s`, `background`, `hue`, `tone`, `expression`, `title`), and `?gen=1`
  renders the first generation's style. Gravatar's `d`, `f` and `r` are accepted and
  ignored. `/openapi.json` describes the endpoint with this Worker's own address.
- **Build.** The endpoint is built against the library at the same tag, from the
  workspace, rather than the copy published to npm.
- **Custom domain.** Attach one in Appflare once the app is installed; the endpoint
  itself has no host names in its config.
