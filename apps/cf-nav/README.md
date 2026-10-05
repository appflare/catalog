# cf-nav

[djkyc/cf-nav](https://github.com/djkyc/cf-nav) is a start page of link cards grouped in
categories, with a search box for several search engines, a light and dark theme, and
drag-and-drop ordering. One Worker serves the page and keeps the links in KV. The
interface is in Chinese.

## Notes

- **Licence.** The repository has no licence file, so the catalog shows it as
  unlicensed: the author has not granted any rights beyond viewing the code.
- **Admin password.** Signing in stores the password itself in the browser's local
  storage, and it is sent with every change. Use a generated password that you use
  nowhere else, and sign out on shared computers.
- **Public and private links.** Anyone with the address sees the public links. Private
  links are left out of the page until you sign in.
- **OpenAI key.** Optional. The endpoint that fills in a new link's name and
  description needs no sign-in, so anyone who finds the address can spend the key. Set
  a spending limit on it, or leave it unset.
- **Third parties.** Link icons are loaded from faviconextractor.com, which so learns
  the domains on your page, and the description helper fetches the linked page from
  the Worker.
- **Pin.** Upstream has no release tags, so the pin follows the default branch.
- No images: the screenshots in the repository are not covered by a licence.
