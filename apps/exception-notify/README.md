# Exception-Notify workspace

[Exception-Notify](https://github.com/GuangYiDing/exception-notify) by XiaoDingSiRen is a
Spring Boot starter that catches unhandled exceptions, finds the failing line and its
author through Git blame, and alerts a DingTalk, Feishu or WeChat Work group. This
entry installs its web workspace (`web/`): each alert links to a page that shows the
exception with its code context and lets you work through it with an AI model. The
README and `pom.xml` declare the Apache License 2.0; the repository has no LICENSE
file.

## Using it

Set `exception.notify.ai.enabled: true` and `exception.notify.ai.analysis-page-url` to
this app's address in the Spring Boot application. The library posts each exception to
`/api/compress` and puts the returned link in the alert.

## Notes

- **AI provider.** The page calls an OpenAI-compatible endpoint straight from the
  browser, with the endpoint, model and key you enter in its settings. They are kept in
  that browser's local storage and never reach the Worker.
- **Open endpoint.** `/api/compress` has no sign-in, as the library needs, and anyone
  holding a link can read that payload. Payloads expire after 30 days. Each new payload
  is written to KV and to D1; KV allows 1,000 writes a day on the free plan, and reads
  fall back to D1.
- **Updates.** The repository's tags version the Java library, so the entry follows
  `main` and moves when `web/` changes.
