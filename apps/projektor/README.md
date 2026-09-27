# Projektor

Upstream's release bundle serves the web app with a `_headers` file that sets a
Content-Security-Policy on every page: scripts only from the app itself (plus
hashes of its inline scripts), no plugins, forms posting only to the app, and
`frame-ancestors 'none'`, so no other site can embed it in a frame. This install
serves the same web app without that file, so its pages carry no
Content-Security-Policy header. The app works the same; it is only less
hardened against injected scripts and framing. Attachments the Worker serves
itself keep their own strict policy, as upstream sets it in the Worker's code.
