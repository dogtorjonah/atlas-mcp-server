# Data handling

Atlas is local-first, but its output is not automatically safe to publish.

## Inputs

The Node host reads files beneath the configured source root. The indexing
pipeline derives normalized paths, source hashes, imports, exports, symbols,
structural edges, snippets, and lexical terms. Callers may add descriptions,
patterns, hazards, highlights, attribution, and external evidence.

Atlas does not require an API key and the default path makes no network calls.
An optional embedding provider is host-supplied code. Review that provider's
data policy before sending it repository text.

## Stored data

Project mode stores data beneath `<source-root>/.atlas/`. User mode stores a
workspace registry and databases beneath the platform's user data directory.
The database can contain:

- repository-relative paths and derived source structure;
- source chunks, retained snapshots, and curated highlights;
- changelog, purpose, pattern, hazard, and convention text;
- optional principal, runtime, and evidence records;
- migration, store identity, backup, and integrity metadata.

Backups preserve the same sensitivity as the database. SQLite WAL and shared
memory files may exist while a store is open.

## What Atlas does not do

- It does not upload the database, telemetry, or repository content.
- It does not infer or estimate provider token usage from characters or bytes.
- It does not sanitize secrets from source snippets or caller-authored text.
- It does not grant access control beyond the operating-system permissions and
  the configured source/data roots.
- It does not dereference opaque external evidence source references.

## Sharing and deletion

Before sharing an Atlas database or backup, treat it like a copy of the indexed
repository and inspect it under the repository owner's policy. Deleting the
database removes the index, not the source repository. Stop Atlas first, then
remove the database, WAL/SHM siblings, backups, and relevant user-mode registry
entry if complete erasure is required.

The npm package contains no runtime databases or release-test artifacts. The
package allowlist is exercised against the exact release tarball.
