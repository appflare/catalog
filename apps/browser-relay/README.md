# Browser Relay Hub

[Browser Relay](https://github.com/reliefeai/browser-relay) by reliefe lets AI agents
use the Chrome browser you already use, signed in, through a Chrome extension, a CLI
and an agent skill. To reach that browser from other machines, the extension connects
out to a relay hub; this entry installs the hub (the repository's `hub/` Worker) in
your account instead of the hosted `relay.linso.ai`. Licensed MIT.

## Notes

- **Device IDs.** Turning on Remote Relay mints a secret Device ID. The extension
  sends it in its first WebSocket frame, and the hub keeps only a hash of it while
  the device is connected. Anyone with the ID can control the browser while Remote
  Relay is on.
- **Endpoints.** `/v1/device/connect` is the extension's WebSocket, `POST /v1/rpc`
  takes commands from the CLI or MCP server, `/v1/status/<routeId>` reports whether a
  device is online, and `/v1/health` answers without credentials.
- **Older extensions.** The hub still accepts extensions that send the Device ID as
  `?token=` in the URL, for upgrades; current extensions never do.
