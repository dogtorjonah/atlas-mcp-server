# @voxxo/atlas

**A codebase brain for any LLM.**

`@voxxo/atlas` indexes a TypeScript/JavaScript codebase and its documentation into structured knowledge — purpose, public API, patterns, hazards, conventions, dependencies, data flows — and serves that knowledge through MCP tools so AI agents can search, inspect, and update code knowledge on demand.

## What It Does

- **Indexes** your codebase into a structured atlas with blurbs, deep extractions, embeddings, and cross-references.
- **Serves** the atlas through MCP tools so agents can search, look up files, explore clusters, and track changes.
- **Stays current** — agents update the atlas inline via `atlas_commit` after editing files, and `atlas_reindex` rebuilds from scratch when needed.
- **Bridges** across workspaces — search and look up files from any atlas database on your machine.

## Quick Start

```bash
git clone https://github.com/dogtorjonah/atlas-mcp-server.git
cd atlas-mcp-server
npm install
npx tsx src/server.ts init ./path/to/your/codebase
```

The init wizard walks you through the codebase path, workspace, provider, model, concurrency, and provider-specific credentials.

## Providers

| Provider | Chat Model | Embedding Model |
|----------|-----------|-----------------|
| **OpenAI** | `gpt-5.4-mini` | `text-embedding-3-small` |
| **Anthropic** | `claude-haiku-4-5` | `voyage-3-small` (or OpenAI fallback) |
| **Gemini** | `gemini-3.1-flash` | `gemini-embedding-001` |
| **Ollama** | `llama3.2` (configurable) | `nomic-embed-text` (configurable) |

## Tools

### Core

| Tool | Purpose |
|------|---------|
| `atlas_search` | Semantic search across your codebase — hybrid BM25 + vector ranking |
| `atlas_lookup` | Full atlas extraction for a specific file — purpose, API, patterns, hazards, imports, callers, recent changes, and staleness detection |
| `atlas_cluster` | Get all files in a named cluster (e.g., `instance-lifecycle`, `signal-coordination`) |
| `atlas_patterns` | Find all files using a specific pattern (e.g., `TTL-cache`, `battery-pack-injection`) |

### Change Tracking

| Tool | Purpose |
|------|---------|
| `atlas_commit` | **The primary write path.** Records what changed (changelog) and updates the atlas entry inline in one call. The agent that just wrote the code provides its own extraction — higher quality than a cold re-extraction by a cheaper model. |
| `atlas_log` | Write a changelog entry without updating the atlas extraction (changelog only) |
| `atlas_changelog` | Query and search the changelog — filter by file, cluster, date range, verification status, or semantic query |

### Maintenance

| Tool | Purpose |
|------|---------|
| `atlas_reindex` | Rebuild atlas data for the workspace — supports dry-run, full pipeline, pass2-only reruns, file-targeted re-extraction, and live progress tracking |

### Cross-Workspace Bridge

| Tool | Purpose |
|------|---------|
| `atlas_bridge` | Search across ALL atlas databases on your machine with RRF fusion |
| `atlas_bridge_list` | Discover all atlas workspaces available on your machine with file counts |
| `atlas_bridge_lookup` | Look up a specific file from any workspace |

### Resource

- **`atlas://context`** — auto-updated codebase context resource. Subscribe for automatic injection of relevant file knowledge, recent queries, and cluster summaries.

## MCP Client Setup

### Claude Code

```json
{
  "mcpServers": {
    "atlas": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/path/to/atlas-mcp-server",
      "env": {
        "ATLAS_DB_PATH": "/path/to/atlas-mcp-server/.atlas/atlas.sqlite",
        "ATLAS_SOURCE_ROOT": "/path/to/your/codebase",
        "ATLAS_WORKSPACE": "your-workspace",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```

### Cursor / Generic MCP Client

```json
{
  "mcpServers": {
    "atlas": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/path/to/atlas-mcp-server",
      "env": {
        "ATLAS_DB_PATH": "/path/to/atlas-mcp-server/.atlas/atlas.sqlite",
        "ATLAS_SOURCE_ROOT": "/path/to/your/codebase",
        "ATLAS_WORKSPACE": "your-workspace"
      }
    }
  }
}
```

## How It Works

The atlas pipeline runs in phases:

1. **Pass 0** — builds the import graph for the codebase.
2. **Pass 0.5** — generates concise blurbs for each file.
3. **Pass 1** — produces deep structured extraction (purpose, public API, patterns, hazards, conventions, key types, data flows, dependencies).
4. **Pass 2** — adds cross-references and blast-radius analysis.
5. **Embed** — stores vectors for semantic search.

Search uses hybrid BM25 + vector ranking with RRF fusion, so both keyword and semantic queries work well.

After the initial index, agents keep the atlas current by calling `atlas_commit` after editing files — the agent provides its own extraction inline (it has maximum context since it just wrote the code), and the atlas entry updates immediately with no background re-extraction needed.

## Configuration

### CLI Flags

| Flag | Purpose |
|------|---------|
| `--wizard` | Force the interactive setup flow |
| `--provider` | Choose `openai`, `anthropic`, `gemini`, or `ollama` |
| `--concurrency` | Set batch size for init runs |
| `--yes` | Skip interactive confirmation prompts |
| `--phase pass2` | Run only pass 2 (cross-refs) during init |
| `--file <path>` | Target specific files during init (repeatable) |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ATLAS_DB_PATH` | Path to the SQLite database |
| `ATLAS_SOURCE_ROOT` | Root directory of the codebase to index |
| `ATLAS_WORKSPACE` | Workspace name (defaults to directory basename) |
| `ATLAS_PROVIDER` | Provider choice: `openai`, `anthropic`, `gemini`, `ollama` |
| `ATLAS_MODEL` | Override the default chat model |
| `ATLAS_CONCURRENCY` | Batch size for pipeline runs |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `VOYAGE_API_KEY` | Voyage AI API key (used by Anthropic provider for embeddings) |
| `OLLAMA_BASE_URL` | Ollama server URL |
| `ATLAS_OLLAMA_MODEL` | Override Ollama chat model |
| `ATLAS_OLLAMA_EMBED_MODEL` | Override Ollama embedding model |
| `ATLAS_SQLITE_VEC_EXTENSION` | Custom path to sqlite-vec extension |

## Architecture

Think of Atlas as a codebase brain:

- The **database** stores structured file knowledge — extractions, embeddings, changelogs, and cross-references in SQLite with sqlite-vec for vector search.
- The **providers** generate blurbs, extractions, and embeddings via OpenAI, Anthropic, Gemini, or Ollama.
- The **MCP server** exposes search, lookup, commit, and bridge tools over stdio.
- The **`atlas://context` resource** injects live codebase context into MCP clients automatically.
- The **file watcher** detects changes and flags stale entries for re-extraction.
- The **bridge** discovers sibling atlas databases on disk for cross-workspace search.

## License

MIT
