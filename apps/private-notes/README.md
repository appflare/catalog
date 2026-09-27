# Private Notes

[Private Notes](https://github.com/tao-t356/private-notes) by tao-t356 is a private text
notebook. The browser encrypts every note's title and body with a key derived from the
vault password (PBKDF2-SHA256, AES-256-GCM), so D1 holds ciphertext; search and
filtering run in the browser. Several passwords can open separate vaults, and a note
can be shared once through a link whose key never reaches the server and whose copy
is deleted when it is opened or expires. The repository has no licence file.

## Before you install

- **The password is the key.** Notes are encrypted with it in the browser. Lose it and
  the notes cannot be read, by you or by anyone else.
- **Not zero-knowledge.** The Worker keeps the password as a secret to check
  sign-ins, so anyone who administers the Cloudflare account can read it. Upstream
  describes this as client-side encryption with a trusted server.

## Notes

- **Changing the password.** Upstream's README describes it: after a change, the first
  sign-in with the new password asks for the old one to unlock existing notes, and the
  old one stays needed until every note is encrypted again. There is no automatic
  re-encryption.
- **Sign-in limits.** Five failed sign-ins from one IP lock it out for 15 minutes.
- **Share links.** A shared note is a separate encrypted copy that is deleted from D1
  when opened; D1 Time Travel can bring it back, so treat an opened link as used, not
  as destroyed.
- **Updates.** Upstream publishes no tags, so the entry follows `main`. Upstream's own
  update tool for forked deployments does not apply here; updates come from this
  catalog.
