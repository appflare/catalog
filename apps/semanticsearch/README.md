# Semantic Search

[Semantic Search](https://semanticsearch.ai) is an HTTP API for searching your own
documents by meaning. Each document is embedded with Workers AI and stored in a
Vectorize index together with its text and metadata.

## Notes

- **Licence.** The repository has no LICENSE file. Its README declares the Apache
  License 2.0 and asks that a product built on it include a link to
  https://semanticsearch.ai/.
- **Keys.** Writer keys may add, delete, read and search; reader keys may only read and
  search. Each secret takes several keys separated by commas.
- **Embedding model.** The index has 256 dimensions for `@cf/google/embeddinggemma-300m`,
  truncated as upstream does. Upstream's `EMBEDDING_MODEL` and `EMBEDDING_DIM` vars are
  not offered, because a different model or size needs an index of another shape.
- **Updates.** Upstream publishes no tags, so the entry follows `main`.
