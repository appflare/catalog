# 2FA

[wuzf/2fa](https://github.com/wuzf/2fa) keeps your two-factor keys and shows their
TOTP and HOTP codes, as an installable web app that works offline. Keys are added by
scanning or pasting a QR code, or imported from Google Authenticator, Aegis, 2FAS,
Bitwarden, and others. Backups run automatically and can be copied to WebDAV, S3,
OneDrive, or Google Drive.

The install creates a KV namespace and a daily backup cron, and generates the
encryption key. Save that key: without it the stored keys and encrypted backups
cannot be read.

2FA is licensed under MIT. Pinned to upstream release tags; new releases merge on
their own once the install check passes.
