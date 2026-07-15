# Changelog

All notable public changes are recorded here. This project follows semantic
versioning beginning with 1.0.0.

## 1.0.0 - 2026-07-14

- Promoted the standalone package to a documented protocol-v1 service.
- Added worker-owned SQLite persistence, bounded supervision, migrations,
  backups, integrity checks, and crash-aware write semantics.
- Added deterministic full and incremental indexing, freshness reconciliation,
  malformed-file reporting, structural references, and repository watching.
- Added structured query, graph, audit, history, snapshot, and diff results with
  stable pagination, evidence metadata, and lexical fallback.
- Added atomic idempotent writeback with attribution and provenance evidence.
- Added typed administration, optional embeddings, a strict MCP adapter, a Node
  composition root, and canonical CLI commands.
- Added cross-platform exact-artifact regression and performance gates.
- Added a separate optional Context Warp receipt adapter package.
- Changed the license for this and later releases from AGPL-3.0-only to MIT.

Earlier 0.1.x releases predate the stable public contract. See `UPGRADING.md`.
