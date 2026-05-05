# Public fixtures

Only reviewed synthetic or public-safe inputs belong here. Preserve type drift,
ID precision boundaries, Unicode and rich-text representation without retaining
real identities, source paths, private text, remote media URLs or credentials.

`metadata/invalid/` contains four relocated minimal synthetic cases.
`metadata/platforms.json` is a new synthetic corpus for the fixed eight adapters.

`metadata/corpus/` contains 35 reconstructed synthetic structural cases. Their
provenance and frozen shape signatures are recorded in `metadata/corpus.json`
and `metadata/shapes.json`.

All active tests use these public fixtures or synthetic temporary data. Real
metadata and local acceptance data remain outside the repository and are never
part of the public tree. See `config/fixture-policy.json` for the fixture policy.
