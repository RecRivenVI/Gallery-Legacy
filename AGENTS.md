# Gallery working conventions

- Report in Chinese, results first. Distinguish automated tests, actual acceptance, and unverified claims.
- Preserve unrelated work. No commit, push or history rewrite without explicit authorization.
- Product scope is eight fixed platforms, personal/localhost/trusted LAN. No dynamic registration, plugin framework, metadata DSL or multi-tenant infrastructure.
- Formal backend: `internal/`; UI: `frontend/`; native host: `desktop/`; thin entry: `cmd/`; cross-implementation contract: `protocol/`. Follow `docs/architecture.md`.
- Filesystem existence is authoritative. Metadata is enrichment only. Missing/invalid metadata and missing/duplicate source IDs must not discard physical entities.
- Only eligible observed files become actual media. Declarations/enrichment never authorize or erase actual media.
- Preserve Catalog Schema v4 semantics and snapshot. Public protocol, Search, Adapter and shape versions have independent meanings.
- Required filesystem incompleteness must propagate and prevent READY/publication. Keep streaming memory bounded.
- Runtime reads one fully verified, finalized READY generation through one active pointer. No direct database fallback, hot swap or READY in-place mutation.
- Real sources are strictly read-only. No screenshots, recordings, private metadata/media/body/identity output. Acceptance reports contain aggregates only.
- Default tests use temporary synthetic trees and public fixtures only; no real source scans or historical test-library manifest. `tests/disposition.json` is an audit record, not an exclusion list.
- Public examples contain no private paths or credentials. Instance data/config/cache/log/session stays outside the repository. Never copy private corpus into fixtures.
- Root package/lockfile is the sole dependency authority. Run `npm run check`, `npm run check:electron`, and `npm test`; do not blindly upgrade dependencies or run audit fix.
- Current stack is Node/Electron/JavaScript. Go/ComposeMP/Tauri are future plans, not implemented product code.
- Update current docs when paths, contracts or commands change. Do not recreate historical phase/preview/next directories or archive dead projects inside this source tree.
