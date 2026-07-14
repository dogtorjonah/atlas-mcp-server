# Standalone Atlas Migration Plan

This plan defines how the promoted standalone package evolves its SQLite schema
without importing Voxxo-only domains or invalidating existing `0.1.0` databases.
Historical migrations are treated as an upgrade contract, not as editable schema
documentation.

## Current schema history

Standalone and production migrations are byte-identical through `0011`. Their
`0012_jonah_memory.sql` files differ, and production alone continues with Therapy
Atlas migrations `0017` and `0018`. Both trees share portable migrations `0013`
through `0016`.

| Migration | Schema effect | Public decision |
| --- | --- | --- |
| `0001_init` | Files, FTS, import edges, vector table, reextract queue, metadata | Retain |
| `0002_changelog` | Changelog, changelog FTS/vector tables, verification indexes | Retain |
| `0002_symbols_references` | Symbols, references, and lookup indexes | Retain; duplicate numeric prefix is historical |
| `0003_atlas_metrics` | Tool metrics | Retain only with product-neutral fields |
| `0004_source_highlights` | Curated source-highlight JSON | Retain |
| `0005_source_chunks` | Source chunks and optional vector table | Retain |
| `0006_changelog_author_indexes` | Author instance, engine, and name indexes | Retain with neutral optional attribution |
| `0007_changelog_recovery_key` | Recovery key and unique partial index | Retain |
| `0008_file_witnesses` | Agent-instance witness records | Preserve for upgrade compatibility; remove from default core behavior pending provenance-provider design |
| `0009_file_tags` | Tags and rebuilt file FTS | Retain |
| `0010_file_snapshots` | Retained source snapshots | Retain |
| `0011_hazards_with_ranges` | Structured ranged hazards | Retain |
| `0012_jonah_memory` | Candidate operator-memory storage under a legacy personal table name | Migrate to neutral operator memory |
| `0013_symbol_identity` | Reindex-proof per-symbol identity | Retain |
| `0014_changelog_model_attribution` | Optional author model | Retain |
| `0015_changelog_engine_type_attribution` | Optional author engine type | Retain |
| `0016_changelog_idempotency` | Retry-safe changelog key and fingerprint | Retain |
| standalone `0017_operator_memory` | Data-preserving rename from the historical candidate table to neutral operator-memory storage | Retain; public standalone head |
| production `0017`–`0018` | Therapy Atlas and ownership | Never promote |

The nested `migrations/migrations/0001_init.sql` was not read by the non-recursive
migration loader and had no package/build consumer. It was removed after the exact
tarball smoke test applied all 17 direct migrations to a fresh database.

## Current runner behavior and hazards

`src/db.ts` currently:

1. Reads only direct `.sql` children of the configured migration directory.
2. Sorts migration filenames lexicographically.
3. Tracks applied migrations by filename alone in `atlas_schema_migrations`.
4. Removes `vec0` statements from each file, executes remaining SQL, then attempts
   vector-table creation separately.
5. Marks the migration applied even when vector-table creation is skipped because
   the extension is unavailable; a later inline heal path creates or repairs
   vector tables when the extension loads.
6. Treats a `duplicate column name` or `already exists` error as proof that the
   entire migration was previously applied and records its filename.
7. Does not store a migration checksum.
8. Wraps each non-vector migration body and its tracking insert in one transaction;
   optional `vec0` statements remain a separately healed capability.

The bootstrap tolerance in item 6 is unsafe for a genuinely partial migration:
an early duplicate can cause later statements in the same file to be skipped and
the filename to be marked complete. The promotion must replace this inference
with explicit schema reconciliation or statement-level idempotency.

Filename-only tracking also means already-released migration files must be
treated as immutable. Editing `0012_jonah_memory.sql` would change fresh installs
without changing existing databases, producing two schemas with the same recorded
migration history.

`0011_hazards_with_ranges.sql` is the narrow exception made during this
pre-release public-source scrub: only its comments and source-path references
change. Its comment-stripped SQL is pinned by
`src/__tests__/migrationSourceCompatibility.test.ts`, and the runner stores no
file checksum, so an installed database neither rejects nor re-applies it. Any
future statement-level change must use a new migration filename.

## Supported schema policy

The package ships a generated migration manifest containing the ordered filename,
comment-stripped SQL checksum, schema generation, and compatibility classification
for every public migration. The runner classifies a database against that manifest
before it executes SQL.

| Detected state | Support level | Required behavior |
| --- | --- | --- |
| No database or zero-byte target | Fresh install | Create a staged database from every packaged public migration, validate it, then publish it atomically |
| Exact prefix of the frozen public history through `0016` | Supported upgrade | Back up and stage, apply the remaining public migrations in order, validate, then atomically replace |
| Complete standalone `0.1.0` history through `0016` | Supported upgrade | Apply standalone `0017_operator_memory` and later promoted public migrations through the same staged path |
| Current promoted schema and matching checksums | Supported no-op | Verify identity, schema, and integrity; apply nothing |
| Known history with optional vector tables absent | Supported degraded state | Preserve lexical data; report vector capability unavailable and heal only through explicit compatible vector maintenance |
| Known filename with a changed executable checksum | Incompatible | Refuse migration and identify the filename, expected checksum, observed checksum, and restore/export options |
| Unknown migration, non-prefix ordering, or partial schema effects | Incompatible or repair-only | Leave the primary untouched; require a named reconciliation/recovery procedure |
| Schema generation newer than this package supports | Unsupported downgrade | Refuse open-for-write and instruct the user to install a compatible/newer Atlas version |
| Production Therapy Atlas tables or migrations | Wrong product/domain | Refuse promotion migration; point to an export into a clean standalone database rather than copying private tables |
| SQLite integrity failure | Corrupt | Skip migrations and enter explicit backup/salvage recovery flow |

Historical rows whose runner stored only filenames may have null checksums. They
are supported only when their filenames form an exact prefix and the observed
required schema matches the frozen release fingerprint. The runner records the
trusted historical checksum during the staged upgrade; it never treats an arbitrary
current file as proof of what ran previously.

## Read-only preflight classification

Before backup or mutation the worker acquires the store/migration lock, quiesces
writers, and opens the database read-only to collect:

1. SQLite header/version and `quick_check`/integrity status.
2. Repository/store identity and schema generation when present.
3. Applied migration filenames, checksums, and ordering.
4. Required table, index, trigger, FTS, and optional-vector fingerprints.
5. Page count and free-space estimates needed for backup, staging, and atomic
   replacement on the same filesystem.
6. Package migration-manifest range and executable checksums.

Classification is deterministic and has no repair side effects. Missing metadata,
duplicate migration rows, an unexpected schema object, or insufficient staging
space produces a typed preflight result. The normal server does not guess that a
partial database is close enough and does not start serving requests while an
upgrade is pending or unresolved.

## Public migration numbering

Standalone and production have intentionally diverged. Public migration numbers
after `0016` belong to the standalone release and do not inherit production's
Therapy Atlas meanings.

The first standalone promotion migration is implemented as:

```text
0017_operator_memory.sql
```

The promotion manifest, migration guide, and compatibility tests must state that
standalone `0017` is unrelated to production `0017_therapy_atlas.sql`.

## Operator-memory compatibility migration

The public API uses `insertAtlasOperatorMemory`, and current code writes only the
neutral table created by `0017`. The migration renames the stored schema rather
than changing the historical `0012` file in place.

For every supported `0.1.0` database, `0012` has run before `0017`. Therefore the
normal upgrade path can safely:

1. Rename `atlas_jonah_memory` to `atlas_operator_memory`.
2. Drop legacy personal-name indexes.
3. Create equivalent `idx_operator_memory_*` indexes.
4. Preserve all rows, timestamps, review state, evidence, dedupe keys, and
   changelog foreign-key relationships.
5. Update `src/db.ts`, types, queries, tests, and documentation to use only
   operator-memory names.

A database that claims `0012` was applied but lacks the legacy table is corrupt or
was manually modified. The upgrade must stop with a diagnostic and backup path;
it must not silently create an empty replacement and discard evidence.

Fresh installs continue to run immutable historical `0012` followed immediately
by `0017`, so the schema at migration head contains only the neutral table and
indexes. Release documentation may describe `0012` as a historical internal name,
but no current public API or user-facing example may expose it.

Implementation evidence: the focused migration suite creates a pre-`0017`
standalone fixture, preserves duplicate dedupe keys, row IDs, timestamps, review
state, evidence, and changelog foreign keys through the rename, writes a new row
through `insertAtlasOperatorMemory`, then reopens and proves `0017` ran once. The
exact clean-installed package smoke applies all 18 packaged migrations and verifies
that only neutral operator-memory schema objects exist at head. The broader frozen-
artifact, staged-replacement, interruption, and recovery suites remain separate
release gates below.

## File-witness compatibility

Migration `0008` already exists in public history. Dropping it during the same
promotion would destroy data without a replacement provenance contract.

For this release:

- Keep the table for upgrade compatibility.
- Do not require canonical agent events or expose file witnesses as a core product
  promise.
- Keep reads empty or host-supplied when no provenance provider exists.
- Prevent witness rows from influencing authoritative source or graph answers.
- Decide in a later version whether a generic provenance provider adopts the
  table or a data-preserving migration retires it.

## Safe runner changes

Before new schema features depend on the runner, implement these safeguards:

1. Back up an existing database before applying any pending migration.
2. Run each non-vector migration body and its tracking insert in one explicit
   transaction whenever SQLite permits it.
3. Preserve special handling for optional `vec0` tables, but record their health
   separately from schema migration completion.
4. Replace whole-file duplicate-error tolerance with explicit bootstrap
   reconciliation for known historical migrations.
5. Record a checksum for newly applied migrations. Existing filename-only rows
   may have a null checksum and must be reconciled against a known release map.
6. Refuse a checksum mismatch for an already-applied new migration and explain the
   recovery path.
7. Acquire a process-level migration/write lock before backup and upgrade.
8. Run integrity and required-table/index checks after migration and before the
   server accepts requests.
9. Retain the original backup until post-upgrade validation completes.
10. Ensure all migration and repair work executes in the standalone worker or
    startup/maintenance process, never inside concurrent MCP request handling.

## Staged upgrade and rollback policy

The primary database is never the migration scratch space. A supported upgrade
uses this sequence under one exclusive store/migration lock:

1. Complete read-only preflight and classification.
2. Checkpoint/close the live SQLite connection so WAL state is represented in the
   database through SQLite's supported mechanisms, not copied as loose sidecars.
3. Create a protected online backup with the SQLite adapter, then verify integrity,
   repository identity, schema fingerprint, byte size, and checksum.
4. Create a staging database from that verified backup on the same filesystem as
   the primary.
5. Apply each pending migration to staging. Its non-vector body and migration-row
   insert run in one transaction. Optional vector capability state is recorded and
   validated separately.
6. After every migration, verify the declared schema delta and checksum record.
7. Run full integrity, required-object, row-relation, identity, and representative
   read/write checks against staging; close and reopen it; rerun discovery as a
   no-op.
8. Persist and fsync a small upgrade-intent record naming the primary, protected
   backup, staging artifact, from/to generations, and expected checksums.
9. Atomically replace the closed primary with the verified staging database using
   the platform's same-filesystem replace primitive; fsync the containing
   directory where supported.
10. Reopen the new primary, verify identity/integrity/head again, clear the intent,
    and only then admit application requests.

If migration or staging validation fails, Atlas quarantines/removes only the
staging artifact, retains the protected backup and failure report, and leaves the
primary byte-for-byte untouched. If replacement succeeds but immediate reopen or
validation fails before any application write is accepted, recovery atomically
restores a verified copy of the protected backup and retains the failed candidate
for diagnosis.

Migrations are forward-only; the release does not ship generic down SQL. Once the
new schema has admitted writes, automatic rollback could discard new data and is
forbidden. The user may explicitly restore a protected backup after acknowledging
the cutoff time and data-loss boundary, or install a forward repair release. A
newer schema is never opened for write by an older package.

An interrupted replace is recovered from the fsynced intent record before normal
open: Atlas validates the primary, staging, and protected backup independently,
selects only a complete artifact matching the recorded identity/checksum, and
reports any ambiguous state for explicit operator choice. It never deletes the
last verified copy.

## Separate release test plans

Fresh-install and upgrade suites are independent gates:

- The fresh suite starts from an absent database and uses only the release-
  candidate tarball's migrations and runtime.
- The upgrade suite creates its starting artifact with the frozen published
  `0.1.0` package/migration set, stores that fixture checksum, then upgrades it with
  the release-candidate tarball. It never constructs the old database using current
  migration code.
- Corruption, interruption, unsupported-version, and concurrency fixtures clone
  one of those immutable starting artifacts before fault injection.
- Passing fresh install cannot compensate for an upgrade failure, and passing an
  upgrade cannot compensate for a fresh-head mismatch. Both exact-artifact suites
  are required for release.

## Fresh-install sequence

The release candidate fresh-install test must:

1. Create a temporary empty data directory.
2. Load the actual packaged migrations, not source-tree substitutes.
3. Run all public migrations in filename order.
4. Verify `atlas_schema_migrations` contains each direct SQL filename exactly once.
5. Verify the neutral operator-memory table exists and the legacy personal table
   does not exist at head.
6. Verify Therapy Atlas tables do not exist.
7. Verify file, graph, symbol, reference, changelog, FTS, snapshot, tag, hazard,
   identity, idempotency, queue, and metadata tables/indexes.
8. Run once without `sqlite-vec`, verify deterministic lexical operation, then
   reopen with the extension and verify vector-table healing.
9. Seed a fixture repository, query it, write metadata, capture a snapshot, close,
   reopen, and confirm persistence.
10. Rerun migrations and prove they are idempotent.

## Upgrade sequence from standalone `0.1.0`

The supported-upgrade test must:

1. Build a real `0.1.0` fixture database using its frozen migrations.
2. Insert representative files, imports, symbols, references, changelog rows,
   snapshots, hazards, tags, file witnesses, operator-memory candidates stored in
   the legacy table, and idempotency data.
3. Close the database and record integrity plus row counts.
4. Install or load the release-candidate package and create a verified backup.
5. Apply only pending public migrations, including `0017_operator_memory`.
6. Verify every pre-upgrade record survives with equivalent relationships.
7. Verify operator-memory APIs read and write the renamed table.
8. Verify no Therapy Atlas table or private field appears.
9. Run representative retrieval, graph, history, writeback, snapshot, and restart
   workflows.
10. Reopen again, rerun migration discovery, and prove no migration repeats.

## Corrupted-state recovery

Integrity failure prevents migration and write-capable open. Atlas does not run SQL
against a corrupt primary in the hope that a new migration repairs it. Recovery
inventory scans only the configured backup root and validates candidates newest to
oldest for SQLite integrity, repository identity, supported schema generation,
migration checksums, and required relationships.

Recovery is explicit:

1. Acquire the exclusive store/recovery lock and re-confirm the primary failure.
2. Preserve the corrupt primary, sidecars, preflight report, and identity metadata
   in a timestamped quarantine directory without following external symlinks.
3. Select a verified backup by immutable backup ID, or create a read-only salvage
   export of individually readable core tables when no valid backup exists.
4. Restore into a new staging file, validate and upgrade that staging file through
   the normal supported path, and show the record/time cutoff.
5. Require explicit confirmation before replacing the primary; preserve both the
   corrupt artifact and chosen backup until the restored database reopens and the
   user releases them.

Startup may report the newest valid recovery candidate but never overwrites the
primary automatically. A missing or invalid backup produces
`AtlasCorruptStoreError` with quarantine, backup-inventory, and salvage/export
guidance. Optional vector-extension absence is a capability state, not corruption;
it must not trigger whole-database recovery.

## Unsupported and incompatible version messages

Preflight failures use structured errors that CLI, MCP, and programmatic consumers
can render without parsing prose:

```ts
interface AtlasSchemaCompatibilityError {
  code:
    | 'ATLAS_SCHEMA_NEWER'
    | 'ATLAS_SCHEMA_HISTORY_DIVERGED'
    | 'ATLAS_SCHEMA_CHECKSUM_MISMATCH'
    | 'ATLAS_SCHEMA_WRONG_DOMAIN'
    | 'ATLAS_STORE_CORRUPT';
  databasePath: string;
  detectedGeneration: string | null;
  supportedRange: { minimum: string; maximum: string };
  offendingMigrations: Array<{
    filename: string;
    expectedChecksum?: string;
    observedChecksum?: string;
  }>;
  validBackupIds: string[];
  actions: AtlasRecoveryAction[];
}
```

Human rendering names what was found, why Atlas refused to write, whether the
primary was changed (normally `no`), where verified backups exist, and concrete
next actions. Guidance is reason-specific:

- newer generation: install the minimum compatible Atlas version or use a matching
  executable; never suggest downgrade migration;
- checksum/history divergence: restore a named verified backup, export into a new
  clean database, or run a documented reconciliation command;
- wrong/private domain: create a clean standalone store and import only supported
  public records;
- corruption: inspect quarantine, list verified backups, or run read-only salvage.

Errors never include credentials or raw private rows. Machine output retains stable
codes and paths; human output may redact home prefixes. A generic "migration
failed" without detected/supported versions and recovery guidance is not an
acceptable terminal message.

## Failure and recovery fixtures

Add fixtures for:

- Missing migration directory.
- Unknown migration already recorded.
- Modified migration checksum.
- Partial historical migration with an unrecorded column or index.
- Recorded `0012` with missing legacy operator-memory table.
- Duplicate migration filename.
- Read-only database and read-only data directory.
- Insufficient disk space or interrupted backup.
- Migration SQL failure midway through a multi-statement file.
- Worker crash during migration, after staging validation, after upgrade-intent
  fsync, during atomic replacement, and before post-replace admission.
- Corrupt primary database with valid backup.
- Corrupt primary database with no valid backup but partially salvageable rows.
- Newer schema generation, divergent migration order, checksum mismatch, and
  production-domain tables, each with stable reason-specific guidance.
- `sqlite-vec` unavailable, incompatible, and later restored.
- Concurrent server/process attempting the same upgrade or first-open identity
  allocation.

Each failure must leave either the original database untouched or a verified
backup plus an actionable error. No recovery path may mark a migration complete
merely because one schema element already exists. Fault tests hash the primary and
protected backup before and after every injected boundary, assert that the server
admits no request during unresolved upgrade state, and prove a restart resolves or
reports the intent record without deleting the last verified copy.

## Schema acceptance checklist

- [x] Historical executable migration SQL through `0016` remains immutable.
- [x] Public `0017_operator_memory.sql` preserves legacy candidate rows and
      relationships in the focused upgrade fixture.
- [x] Current code and public schema names use neutral operator-memory naming;
      personal identifiers remain only in explicit historical upgrade recognition.
- [x] The exact package migration list and fresh-head schema contain no production
      Therapy Atlas migration or table.
- [x] Duplicate nested bootstrap migration is removed after exact package-consumer
      and fresh-install verification.
- [ ] Migration runner has backup, locking, transaction, checksum, integrity, and
      recovery behavior.
- [ ] Packaged migration manifest records executable checksums, schema generation,
      compatibility class, and required schema fingerprints.
- [ ] Supported upgrades migrate and validate staging, then atomically replace;
      fault injection proves the primary and last verified backup survive every
      boundary.
- [ ] Fresh-install, upgrade, rerun, failure, and recovery fixtures pass.
- [ ] Packaged migrations match the files used in release-candidate tests.
- [ ] Newer, divergent, wrong-domain, and corrupt schemas fail with stable error
      codes, detected/supported versions, verified backup IDs, and concrete actions.
- [ ] Migration and database I/O execute outside concurrent MCP request handling.
