# ShotSync

[Defiabell/shotsync](https://github.com/Defiabell/shotsync) is a small private pool for
images and text snippets shared between your own devices. Its web app (installable on a
phone's home screen) uploads photos and screenshots, converted and thumbnailed in the
browser, and text snippets to an R2 bucket; any device with the access token sees them,
and any item can get a signed public link that lasts 7 days. Licensed MIT.

## Notes

- **One token.** Anyone with the address and the access token can view, upload and delete.
  It suits one person or a trusted group.
- **Retention.** Upstream deletes items after 30 days with an R2 lifecycle rule that you add
  to the bucket in the dashboard; the install does not create it.
- The interface is in Chinese; upstream's README gives the English for each button.
- Upstream's later hosted, multi-account variant uses a separate config and is not part of
  this entry.
