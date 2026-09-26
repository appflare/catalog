# NodeWarden

[shuaiplus/nodewarden](https://github.com/shuaiplus/nodewarden) is a Bitwarden-compatible
server. The official Bitwarden desktop and mobile apps and browser extensions sync to
it, and it serves the Bitwarden web vault itself. It supports TOTP, passkey and
YubiKey sign-in, attachments and Send, import and export, scheduled backups to WebDAV
or S3, and several users by invite. Organizations, collections, and SSO are not
implemented.

The install creates the D1 database (with upstream's migration), an R2 bucket for
attachments and Send files, the two Durable Objects for live sync and backups, and a
cron that runs every five minutes for scheduled backups. It generates the token
signing secret.

NodeWarden is licensed under LGPL-3.0 and is not affiliated with Bitwarden. Pinned to
upstream release tags; new releases merge on their own once the install check passes.
