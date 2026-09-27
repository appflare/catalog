# LLM API Proxy

[rxliuli/llm-api-proxy](https://github.com/rxliuli/llm-api-proxy) (formerly
openai-api-proxy) serves one OpenAI-compatible API, and an Ollama-compatible one, in
front of many model providers: OpenAI, Anthropic, Claude on Vertex AI, Gemini,
DeepSeek, Groq, xAI Grok, Cerebras, Azure OpenAI, Cohere, Alibaba Cloud Bailian,
Moonshot, 01.AI, OpenRouter and an Ollama server of your own. Licensed GPL-3.0.

## Notes

- **Keys.** The provider keys live on the Worker as secrets. A provider is served once
  every setting it needs is set; `/v1/models` lists what is on. Callers never see the
  provider keys: they send the proxy API key, which the install form generates. Without
  it the Worker answers 401 to everything.
- **Unset means absent.** Upstream turns a provider on when its settings exist, even
  empty ones, so every optional setting here stays off the Worker until it has a value.
- **Ollama API.** Clients that cannot send headers use `/ollama/<proxy API key>/v1`.
  That puts the key in the URL, so it appears in the Worker's request logs.
- **Browsers.** Set the allowed browser origin to call the proxy from one web app;
  without it browsers get no CORS headers.
- **Pin.** Upstream has no release tags, so the pin follows the default branch and each
  bump is reviewed by a maintainer.
- No images: the repository publishes none.
