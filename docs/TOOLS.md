# Atlas tools and commands

This guide describes the stable 1.x transport surface. Programmatic requests use
camelCase. MCP and CLI JSON use snake_case. Examples below use CLI spelling.

Every operation returns a protocol-v1 envelope:

```json
{
  "protocol_version": "1",
  "ok": true,
  "request_id": "opaque-id",
  "data": {},
  "meta": {
    "capabilities": {},
    "warnings": [],
    "extensions": []
  }
}
```

Expected failures set `ok` to `false` and include `error.code`, `message`, and
`retryable`. Do not parse human text output.

## Global CLI options

Options may appear after the command:

| Option | Meaning |
|---|---|
| `--source-root <path>` | Authorized repository root; defaults to the current directory |
| `--workspace <name>` | Explicit workspace label |
| `--db <path>` | Explicit SQLite database path |
| `--data-mode project|user` | Project-local or user-global layout |
| `--format json` | Compact structured JSON output |
| `--request <json|@file|->` | Explicit JSON object; `-` reads stdin |

Unknown commands and invalid request shapes exit with code 2. Not-found results
use 3, temporary/capability failures use 4, and internal or I/O failures use 5.

## Lifecycle and administration

```bash
atlas init [repository] [--no-index]
atlas config show --source-root <repository>
atlas index [path ...] [--full]
atlas migrate [--dry-run] [--no-backup]
atlas backup [--protected]
atlas doctor [--include-optional]
atlas workspace list [--include-unavailable]
atlas watch [path-prefix ...] [--debounce-ms 250]
```

The equivalent MCP tool is `atlas_admin` with actions `index`, `migrate`,
`backup`, `doctor`, and `workspace_list`.

Admin request examples:

```json
{"action":"index","paths":["src"],"full":false}
```

```json
{"action":"doctor","checks":["integrity","schema","lexical"],"include_optional":true}
```

`phase: "embeddings"` reports capability unavailable unless a host has supplied
that optional capability. Migrations validate lineage and checksums. Backup
results include a durable backup ID and integrity verdict.

## Query

CLI form:

```bash
atlas query <action> [request options]
```

MCP tool: `atlas_query`.

| Action | Required focus | Purpose |
|---|---|---|
| `search` | `query` | Ranked lexical retrieval |
| `lookup` | `file_path` | File metadata, evidence, and optional source |
| `brief` | `file_path` | Compact file orientation |
| `snippet` | `file_path` plus lines or symbol | Bounded current source |
| `similar` | `file_path` or query context | Deterministic lexical similarity |
| `plan_context` | `query` | Bounded context seeds for a task |
| `cluster` | cluster or file focus | Cluster membership and summary |
| `patterns` | optional pattern/filter | Recorded patterns and hazards |
| `history` | optional file/filter | Changelog entries, count, timeline, or groups |
| `catalog` | optional query | Repository catalog summary |
| `ask` | `query` | Evidence assembly, not an LLM-generated answer |
| `snapshot` | `file_path` or `changelog_id` | Historical/current retained source |
| `diff` | file/changelog endpoints | Bounded unified source diff |

Common bounds include `limit`, `cursor`, and `character_budget`. Source ranges
are one-indexed. Cursors are opaque and request-bound.

```bash
atlas query search --query "worker supervision" --limit 20 --format json
atlas query lookup --file-path src/worker.ts --include-source true --format json
atlas snapshot --file-path src/worker.ts --at latest --format json
atlas diff --file-path src/worker.ts --from 41 --to latest --context-lines 3 --format json
```

History filters include `since`, `until`, `order`, `bucket`, `group_by`,
`breaking_changes`, `principal_id`, `runtime_name`, and
`verification_status`.

## Graph

CLI form:

```bash
atlas graph <action> [request options]
```

MCP tool: `atlas_graph`.

| Action | Purpose |
|---|---|
| `impact` | Files/symbols downstream of a change |
| `neighbors` | Bounded adjacent imports, importers, or references |
| `trace` | Path between files or symbols |
| `cycles` | Import cycles |
| `reachability` | Dead files, dead exports, entrypoints, or path reachability |
| `graph` | Bounded nodes and edges |
| `cluster` | Structural cluster view |

Useful fields include `file_path`, `symbol`, `depth`, `direction`, `edge_types`,
`include_references`, `include_symbols`, `from`, `to`, `max_hops`, `weighted`,
`max_nodes`, and `max_edges`.

```bash
atlas graph impact --file-path src/public.ts --depth 3 --include-symbols true --format json
atlas graph trace --from src/a.ts --to src/b.ts --max-hops 12 --weighted true --format json
```

## Audit

CLI form:

```bash
atlas audit gaps --min-severity medium --format json
atlas audit smells --file-path src/large.ts --format json
atlas audit hotspots --top-n 20 --format json
```

MCP tool: `atlas_audit`; actions are `gaps`, `smells`, and `hotspots`.
Optional fields include cluster, path, test inclusion, gap types, severity,
weights, time filters, and result bounds.

Audit findings are deterministic signals, not proof that code is wrong. Verify
them against current source and reachability before deleting or refactoring.

## Writeback

CLI writeback accepts an explicit JSON request:

```bash
atlas commit --request @commit.json --source-root /absolute/path/to/repository
```

MCP tool: `atlas_commit`.

Minimal request:

```json
{
  "file_path": "src/worker.ts",
  "changelog_entry": "Moved SQLite work behind the worker boundary.",
  "idempotency_key": "release-1-worker-boundary",
  "purpose": "Owns serialized persistence operations.",
  "patterns": ["single worker-owned SQLite connection"],
  "hazards": ["Do not open this database on a request-handling thread."]
}
```

`expected_version` provides optimistic concurrency. Reusing an idempotency key
with the same payload returns the durable result; reusing it with different
content is a write conflict. Source highlights use one-indexed ranges. Evidence
payloads require explicit namespaces, schema/provider identities, subjects,
authority, confidence, and hashes.

## MCP server

```bash
atlas mcp --source-root /absolute/path/to/repository --transport stdio
```

Only stdio is built into 1.0.0. The adapter uses strict request schemas,
propagates cancellation to the service, returns the protocol envelope in
`structuredContent`, and marks failures with MCP `isError`.

Compatibility tools retained for 1.x are `atlas_snapshot`, `atlas_diff`,
`atlas_changelog_diff`, `atlas_worktree_status`, and `atlas_worktree_diff`.
New clients should use the canonical query/admin tools when an equivalent action
exists.

## Programmatic service

Open the Node composition root:

```js
import { openAtlasNodeHost } from '@voxxo/atlas/node';

const host = await openAtlasNodeHost({ sourceRoot: process.cwd() });
try {
  const result = await host.service.query({ action: 'catalog' }, {
    timeoutMs: 2_000,
    signal: AbortSignal.timeout(2_500),
    requestId: 'catalog-1',
  });
  console.log(result);
} finally {
  await host.close();
}
```

The service methods are `query`, `graph`, `audit`, `commit`, `admin`, and
`close`. Indexing is the `admin({ action: 'index' })` operation in 1.0.0. Store
queues, deadlines, cancellation, crash failures, and shutdown are owned by the
persistence supervisor.

Low-level `@voxxo/atlas/db` APIs are synchronous compatibility exports. Do not
call them from latency-sensitive event loops. New hosts should use
`@voxxo/atlas/node`, `service`, and `persistence`.
