# Sveltia CMS Authenticator

[sveltia/sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth) is the OAuth
client that lets people sign in to Sveltia CMS, or Decap CMS, with GitHub or GitLab.
Upstream notes that most sites do not need it: it is for GitHub sites whose editors
should sign in without making personal access tokens. Licensed MIT.

## Notes

- **Order of setup.** The OAuth app's callback URL is `<workerUrl>/callback`, so install
  first, register the OAuth app with that URL, then set the client ID and secret in the
  app's settings. Point the CMS at the install with `base_url` under `backend` in
  `admin/config.yml`.
- **Allowed hostnames.** Upstream treats `ALLOWED_DOMAINS` as optional and strongly
  recommends it. It is required here: the Worker hands access tokens only to pages on
  those hosts, and with an empty list it hands them to any site.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
- No images: the repository publishes none.
