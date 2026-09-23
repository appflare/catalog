# OpenAI Gemini

OpenAI Gemini is an OpenAI-compatible API adapter for Gemini. It translates OpenAI API requests (chat completions, embeddings, and the model list) into calls to Google's Gemini API, so tools that only speak the OpenAI API can use Gemini models.
It needs no bindings or stored secrets: each client sends its own Gemini API key as the bearer token, and clients use `/v1` on the Worker's URL as their API base.
