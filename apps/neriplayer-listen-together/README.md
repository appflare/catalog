# NeriPlayer Listen Together

[NeriPlayer-LTW](https://github.com/TheSmallHanCat/NeriPlayer-LTW) is the
listen-together server of [NeriPlayer](https://github.com/cwuom/NeriPlayer), a
multi-source Android music player. A host creates a room, listeners join with its
invite link, and the Worker keeps playback, queue, track changes and room settings in
sync over WebSockets. It stores no music account credentials and does not proxy audio.

## Notes

- **Connecting the app.** In NeriPlayer's settings, open the listen-together server
  settings, enter the install's address, and run the availability test.
- **Rooms.** Anyone who knows the address can create rooms; joining needs the room's
  invite link. With audio link sharing on, the host's resolved stream links are shared
  with the room, so use it with people you trust.
- **Storage.** One SQLite Durable Object per room holds its state. A room whose host
  stays away for ten minutes closes and its storage is cleared.
- **Token secret.** `LISTEN_TOGETHER_TOKEN_SECRET` signs members' 24-hour tokens; the
  install generates it. Replacing it signs everyone out of open rooms.

The repository states no licence (no LICENSE file, nothing in its README or
`package.json`), so the entry shows none. NeriPlayer itself is GPL-3.0, but that
covers the app's repository, not this separate one. Upstream has no release tags; the
entry follows the default branch.
