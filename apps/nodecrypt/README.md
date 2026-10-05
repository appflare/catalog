# NodeCrypt

[shuaiplus/nodecrypt](https://github.com/shuaiplus/nodecrypt) is end-to-end encrypted
group chat in the browser. People join a room by name, with an optional password that
becomes part of the encryption key; keys are exchanged with ECDH and every message is
encrypted on the device. The Worker only relays ciphertext, keeps no history, and
needs no accounts. Private messages, images, and files are supported.

The install creates one Durable Object class that relays each room. There is nothing
to configure.

NodeCrypt is licensed under ISC. Upstream has no release tags, so the pin follows
main.
