# Bark Worker

[cwxiaos/bark-worker](https://github.com/cwxiaos/bark-worker) is a server for
[Bark](https://github.com/Finb/Bark), an iOS app that receives custom push
notifications. It implements the Bark server API (register, ping, healthz, info, and
push, including batch pushes), so scripts and services can notify your iPhone with a
single HTTP request.

The install creates the D1 database with upstream's migrations. Devices register
from the Bark app; close registration in the settings once yours are added, and set
push credentials to require basic auth on pushes.

Bark Worker is licensed under GPL-3.0. Pinned to upstream release tags; new releases
merge on their own once the install check passes.
