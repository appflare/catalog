# FormZero

[FormZero](https://github.com/BohdanPetryshyn/formzero) is a form backend for static
sites by Bohdan Petryshyn. Point an HTML form's `action`, or a `fetch` call, at a form's
endpoint; submissions are stored in D1 and shown in a dashboard with a 30-day chart,
search and CSV export. Licensed MIT.

## Notes

- **One account.** The first person to sign up owns the instance, and sign-up closes
  after that, so create the account right after installing.
- **Session secret.** `BETTER_AUTH_SECRET` is generated. Setting a new value signs you
  out; forms, submissions and endpoints are kept.
- **Build.** React Router through the Cloudflare Vite plugin. The four D1 migrations
  in `migrations/` run on install and update, as upstream's `npm run migrate` applies
  them.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
