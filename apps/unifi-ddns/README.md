# UniFi DDNS

[willswire/unifi-ddns](https://github.com/willswire/unifi-ddns) lets a UniFi gateway
(UDM, UXG, USG) keep Cloudflare DNS records on its current public IP, which the
built-in Cloudflare option in UniFi Network 9.1.92+ does not fully cover: several
hostnames per entry, IPv4 and IPv6 together, and keeping a record's proxy status.

The Worker has no secrets or settings of its own. The router sends a Cloudflare
user API token with every update request, so the token stays in the UniFi
controller. That token needs `Zone.DNS` edit on exactly one zone, and the records
to update must already exist.

Pinned to upstream release tags.
