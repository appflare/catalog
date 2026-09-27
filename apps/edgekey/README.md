# EdgeKey

[EdgeKey](https://github.com/34892002/edgeKey) by ggyy is a shop for digital goods (card
keys, codes, accounts) built with Vike on a Worker and D1: a storefront, an admin panel,
payment through BEpusdt, Epay, Alipay or Stripe, and automatic delivery once an order
is paid. Licensed MIT. The interface and upstream's docs are mainly in Chinese.

## Notes

- **Admin account.** The install creates the admin account `admin` with the password
  from the install form, hashed as EdgeKey hashes it (bcrypt). Appflare does not keep
  the password: copy it before you install. Sign in at `/admin`.
- **Upstream's default admin.** Upstream's seed file (`scripts/seed.sql`) also adds an
  `admin` account, with the password `admin123456` published in its README, whenever
  none exists. The install claims the name `admin` first, so that default never lands.
  The seed file runs again on every update, though: if the `admin` account is ever
  deleted, the next update re-creates it with the published password. Keep the
  account, or change that password right after such an update.
- **Database.** The tables come from the migrations in `prisma/migrations`; the seed
  file adds the site settings and the email templates on every install and update,
  each only when missing, so your changes are kept.
- **Cron.** Every five minutes a cron trigger closes orders that were never paid.
- **Turnstile.** Set both Turnstile keys to guard the admin sign-in page; with only one
  set, the check stays off.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
