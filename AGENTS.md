# Gallery working conventions

- Report in Chinese, results first. Distinguish automated tests, actual acceptance, and unverified claims.
- Preserve unrelated work. No commit, push or history rewrite without explicit authorization.
- Product scope is nine fixed platforms (including the Venera download library), an independent read-only file browser, and the existing public-read/localhost deployment. Administrative operations remain local and instance-authenticated. No dynamic registration, plugin framework, metadata DSL or multi-tenant infrastructure.
- Formal backend: `internal/`; UI: `frontend/`; native host: `desktop/`; thin entry: `cmd/`; cross-implementation contract: `protocol/`. Follow `docs/architecture.md`.
- Filesystem existence is authoritative. Metadata is enrichment only. Missing/invalid metadata and missing/duplicate source IDs must not discard physical entities.
- Only eligible observed files become actual media. Declarations/enrichment never authorize or erase actual media.
- Preserve Catalog Schema v4 semantics and snapshot. Public protocol, Search, Adapter and shape versions have independent meanings.
- Required filesystem incompleteness must propagate and prevent READY/publication. Keep streaming memory bounded.
- READY generations remain immutable checkpoints. Explicit liveUpdates mode seeds an instance-owned live database only from a verified checkpoint; complete work batches update Catalog, Search and revision in one transaction. Never read a BUILDING candidate or mutate READY in place. Partial scan failure keeps confirmed live commits; deletion requires complete scope.
- Real sources are strictly read-only. No screenshots, recordings, private metadata/media/body/identity output. Acceptance reports contain aggregates only.
- Default tests use temporary synthetic trees and public fixtures only; no real source scans or historical test-library manifest. `tests/disposition.json` is an audit record, not an exclusion list.
- Public examples contain no private paths or credentials. Instance data/config/cache/log/session stays outside the repository. Never copy private corpus into fixtures.
- Root package/lockfile is the sole dependency authority. Run `npm run check`, `npm run check:electron`, and `npm test`; do not blindly upgrade dependencies or run audit fix.
- Current stack is Node/Electron/JavaScript. Go/ComposeMP/Tauri are future plans, not implemented product code.
- Update current docs when paths, contracts or commands change. Do not recreate historical phase/preview/next directories or archive dead projects inside this source tree.
- Incremental/scoped updates still publish a complete new generation; distinguish reused Catalog records from metadata rereads and Search rebuilds. Keep scoped deletion completeness and baseline race checks.
- `tools/manager-test.js` is an explicit staging-only authenticated loopback test host; it must not be imported by the production Runtime or control a production/8081 instance. Browser automation uses synthetic data or aggregate Manager state only; no Computer Use or media capture.
