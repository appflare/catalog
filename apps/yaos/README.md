# YAOS

[kavinsood/yaos](https://github.com/kavinsood/yaos) syncs Obsidian vaults in real time.
Markdown edits merge as CRDTs across devices, so concurrent edits do not conflict, and
attachments and snapshots are kept in R2. It has two parts: the Obsidian plugin, from
Obsidian's community plugins, and this server.

The install creates the two Durable Objects that hold each vault and the server's
configuration, and an R2 bucket for attachments and snapshots. There is nothing to
fill in: the first person to open the server claims it, which creates the sync token
and a setup link for the plugin.

YAOS is licensed under 0BSD. Pinned to upstream release tags; new releases merge on
their own once the install check passes.
