# Atlas

Atlas is deterministic, local-first code intelligence for software agents,
command-line workflows, and MCP clients. It indexes a repository into a
project-local SQLite store, combines lexical search with structural analysis,
and keeps human or agent-authored knowledge beside the code it describes.

Atlas runs without an API key. Indexing, ranking, graph traversal, snapshots,
diffs, and writeback are local. Optional embedding providers are explicit and
never replace the deterministic lexical result order.

## What you get

- repository indexing with Tree-sitter structure, imports, symbols, call edges,
  cross-references, and FTS5 search;
- bounded query, graph, audit, history, snapshot, and diff operations;
- atomic, idempotent metadata writeback with attribution and evidence;
- a worker-owned SQLite runtime so public async operations do not block their
  caller while database work runs;
- a CLI, a typed programmatic API, and a strict MCP adapter over the same result
  envelopes;
- project-local or user-global storage, migrations, verified backups, health
  checks, and explicit capability reporting.

## Requirements

- Node.js 20 or newer
- npm 10 or another npm-compatible installer
- a platform supported by the native `better-sqlite3`, `sqlite-vec`, and
  Tree-sitter packages

## Install

Install Atlas in the project that will run it:

```bash
npm install --save-dev @voxxo/atlas
```

Initialize and index a repository:

```bash
npx atlas init /absolute/path/to/repository
```

The default project-local database is `<repository>/.atlas/atlas.sqlite`.
Use `--data-mode user` when state should live under the current user's data
directory instead.

## CLI quickstart

```bash
# Verify the store and schema.
npx atlas doctor --source-root /absolute/path/to/repository --format json

# Search with a stable structured envelope.
npx atlas query search \
  --source-root /absolute/path/to/repository \
  --query "authentication middleware" \
  --limit 10 \
  --format json

# Show the import impact of one file.
npx atlas graph impact \
  --source-root /absolute/path/to/repository \
  --file-path src/auth.ts \
  --depth 2 \
  --format json

# Keep the index fresh while editing.
npx atlas watch --source-root /absolute/path/to/repository
```

The `atlas-mcp` binary remains a 1.x compatibility alias. New integrations
should call `atlas mcp`.

## MCP quickstart

Start the stdio server directly:

```bash
npx atlas mcp --source-root /absolute/path/to/repository
```

Or use the ready-to-edit client configuration in
[`examples/mcp-config.json`](examples/mcp-config.json). The server exposes
`atlas_query`, `atlas_graph`, `atlas_audit`, `atlas_commit`, `atlas_admin`, and
the 1.x snapshot/diff compatibility tools. All canonical tools return the same
protocol-v1 envelope in `structuredContent` that the programmatic service
returns.

## Programmatic quickstart

```js
import { openAtlasNodeHost } from '@voxxo/atlas/node';

const host = await openAtlasNodeHost({
  sourceRoot: '/absolute/path/to/repository',
  dataMode: 'project',
});

try {
  const indexed = await host.service.admin({ action: 'index', full: true });
  if (!indexed.ok) throw new Error(indexed.error.message);

  const result = await host.service.query({
    action: 'search',
    query: 'authentication middleware',
    limit: 10,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await host.close();
}
```

[`examples/quickstart.mjs`](examples/quickstart.mjs) is the runnable version.

## How indexing works

Atlas performs a deterministic pipeline:

1. discover source and configuration files;
2. normalize repository-relative paths and extract imports/exports;
3. parse supported languages with Tree-sitter;
4. derive symbols, structural edges, flow, clusters, and cross-references;
5. reconcile changed and deleted files, then refresh lexical indexes.

Malformed files are reported as failures rather than silently treated as empty.
Incremental indexing invalidates the relevant dependent records; a full or repair
run rebuilds the broader derived state.

## Search and optional embeddings

Lexical BM25/FTS retrieval is always available after indexing and defines the
deterministic fallback order. The public embedding controller accepts an
explicit provider and immutable identity: provider, model, dimensions,
normalization, and metric. Provider errors, dimension drift, or missing vectors
degrade to labeled lexical results; Atlas does not make network calls merely
because an embedding dependency is installed.

## Writeback

`atlas_commit` records why a file exists or changed. It can update purpose,
blurb, patterns, hazards, public API notes, and curated source highlights while
preserving changelog history. Writes support optimistic versions and
idempotency keys. Attribution and external evidence are optional, typed, and
stored separately from the core file record.

Atlas does not generate these descriptions with an LLM. The caller provides
them at the moment it has the relevant context.

## Data and privacy

Atlas reads the repository you authorize and stores derived source intelligence
locally. Source snippets and caller-authored metadata may contain sensitive
material; the database is not a sanitized export. Atlas has no telemetry or
hosted service in the default package.

See [Data handling](docs/DATA_HANDLING.md) and [Security](SECURITY.md) before
indexing private repositories or sharing `.atlas` files.

## Public surfaces

The stable 1.x package entrypoints are:

- `@voxxo/atlas` — aggregate entrypoint;
- `@voxxo/atlas/service` — async application service;
- `@voxxo/atlas/persistence` — worker-backed SQLite store;
- `@voxxo/atlas/indexing` — indexing and watcher contracts;
- `@voxxo/atlas/writeback` — commit executor;
- `@voxxo/atlas/admin` — administration contracts;
- `@voxxo/atlas/embedding` — optional embedding controller;
- `@voxxo/atlas/mcp` — MCP adapter;
- `@voxxo/atlas/node` — Node composition root;
- `@voxxo/atlas/db`, `paths`, `types`, and `pipeline` — low-level 1.x
  compatibility exports.

Read [PUBLIC_API.md](PUBLIC_API.md) for the normative contract and
[docs/TOOLS.md](docs/TOOLS.md) for commands and request examples.

## Development

```bash
npm ci
npm run check
npm test
npm run test:package
npm run test:release
```

The release gate packs one candidate tarball, installs that exact artifact, and
runs smoke, performance, package-content, migration, and native-runtime checks.
The checked-in CycloneDX SBOM is generated with `npm run sbom` and verified with
`npm run sbom:check`.

## Context Warp adapter

The optional `@voxxo/atlas-context-warp` package lives under
`packages/context-warp-adapter`. It maps digest-only Context Warp prepare
receipts into Atlas provenance evidence. Atlas and Context Warp do not depend on
each other; only the adapter declares both as peers. Nothing in the adapter
uploads transcript or folded-view content.

## License

Atlas 1.0.0 and later are available under the [MIT License](LICENSE). Earlier
versions remain available under the license granted with those versions. See
[UPGRADING.md](UPGRADING.md) for the license and schema transition and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency notices.
