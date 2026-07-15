# Upgrading Atlas

## From 0.1.x to 1.0.0

Atlas 1.0.0 is a deliberate contract boundary. Back up the existing database,
upgrade the package, run a dry-run migration, then run the health check before
normal use.

```bash
npx atlas backup --source-root /absolute/path/to/repository --protected --format json
npm install --save-dev @voxxo/atlas@1
npx atlas migrate --source-root /absolute/path/to/repository --dry-run --format json
npx atlas migrate --source-root /absolute/path/to/repository --format json
npx atlas doctor --source-root /absolute/path/to/repository --include-optional --format json
```

The runtime applies migrations in filename order and records their checksums.
Unknown newer schemas, missing history, reordered migrations, checksum changes,
wrong-domain databases, and failed integrity checks stop with explicit errors.
Atlas does not silently replace an incompatible store.

The 1.0 lineage currently ends at `0019_commit_evidence.sql`. The upgrade:

- preserves file, changelog, snapshot, symbol, reference, and operator-memory
  row identities;
- migrates legacy personal-memory naming to neutral operator-memory naming;
- adds persistence runtime metadata and writeback evidence tables;
- retains historical migration filenames required to recognize older stores.

If a migration cannot finish safely, leave the original store untouched and use
the verified backup ID returned by the operation. Do not copy an open SQLite
database with ordinary file-copy tools.

## API and command changes

- `atlas` is the canonical binary.
- `atlas-mcp` remains a compatibility alias for `atlas mcp` through 1.x.
- Programmatic requests use camelCase; MCP and CLI JSON use documented
  snake_case fields.
- Expected operational failures are `AtlasResult` data rather than thrown
  errors after service construction.
- The canonical MCP tools are `atlas_query`, `atlas_graph`, `atlas_audit`,
  `atlas_commit`, and `atlas_admin`. Snapshot and diff aliases remain for 1.x.
- Dense retrieval is optional and explicitly configured; lexical search remains
  the deterministic fallback.

Low-level `db`, `paths`, `types`, and `pipeline` subpaths are retained for 1.x
compatibility. They are not the recommended host boundary. Use `node`, `service`,
and `persistence` for new integrations.

## License change

Atlas 1.0.0 is released under MIT. Earlier releases were distributed under
AGPL-3.0-only; those existing grants remain valid for the versions and copies to
which they applied. The new license does not retroactively revoke them. See
`RELICENSE_AUDIT.md` for the authorship audit that supported the transition.

Third-party code keeps its own license. Review `THIRD_PARTY_NOTICES.md` and the
CycloneDX SBOM before redistributing a packaged copy.
