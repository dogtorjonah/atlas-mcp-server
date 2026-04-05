# @voxxo/atlas

**A codebase brain for any LLM.**

`@voxxo/atlas` indexes a codebase into structured knowledge — purpose, public API, patterns, hazards, conventions, dependencies, data flows, cross-references, and community clusters — and serves that knowledge through MCP tools so AI agents can search, inspect, and update code knowledge on demand.

## Highlights

- **Multi-language** — TypeScript, TSX, JavaScript, Python, Go, Rust, and Java via tree-sitter AST parsing
- **Deterministic foundation** — structural analysis, data-flow edges, cross-references, and community detection run without any LLM calls
- **LLM-enriched** — blurbs and deep extractions use your choice of provider (OpenAI, Anthropic, Gemini, Ollama)
- **Self-guiding** — tool responses include contextual guidance hints so the AI knows what to do next, no external orchestrator needed
- **Hybrid search** — BM25 + vector ranking with RRF fusion for both keyword and semantic queries
- **Cross-workspace bridge** — search and look up files from any atlas database on your machine

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
| **None** | — | — | Deterministic-only mode: pass0-struct, pass0-flow, pass2, pass3 all run without a provider |

## Tools

Atlas exposes two tool surfaces: **composite tools** (fewer tools, action-dispatched) and **standalone tools** (one tool per action, backward-compatible). Both are registered simultaneously — use whichever your client prefers.

### Composite Tools (Recommended)

5 tools that cover all 21+ actions via an `action` parameter:

| Tool | Actions | Purpose |
|------|---------|---------|
| `atlas_query` | `search`, `lookup`, `brief`, `snippet`, `cluster`, `patterns`, `similar`, `plan_context`, `history` | All retrieval — finding, reading, and exploring code knowledge |
| `atlas_graph` | `impact`, `reachability`, `neighbors`, `trace`, `cycles`, `graph` | All structural analysis — dependency graphs, blast radius, import chains |
| `atlas_audit` | `gaps`, `smells`, `hotspots` | All quality analysis — dead code, code smells, churn hotspots |
| `atlas_admin` | `reindex`, `bridge_list`, `flush` | All maintenance — pipeline runs, workspace discovery, cache invalidation |
| `atlas_commit` | — | The primary write path — records changes and updates atlas entries inline |

### Standalone Tools

Each action also exists as its own tool (`atlas_search`, `atlas_lookup`, `atlas_impact`, etc.) for backward compatibility and clients that prefer granular tool lists.

### Change Tracking

| Tool | Purpose |
|------|---------|
| `atlas_commit` | Records what changed and updates the atlas entry inline — the agent provides its own extraction (highest quality since it just wrote the code) |
| `atlas_log` | Write a changelog entry without updating the extraction |
| `atlas_changelog` | Query and search the changelog — filter by file, cluster, date range, verification status, or semantic query |

### Cross-Workspace Bridge

| Tool | Purpose |
|------|---------|
| `atlas_bridge` | Search across ALL atlas databases on your machine with RRF fusion |
| `atlas_bridge_list` | Discover all atlas workspaces available on your machine |
| `atlas_bridge_lookup` | Look up a specific file from any workspace |

### Resource

- **`atlas://context`** — auto-updated codebase context resource. Subscribe for automatic injection of relevant file knowledge, recent queries, and cluster summaries.

## How It Works

The atlas pipeline runs in 8 phases. The first three and last two are fully deterministic (no LLM needed):

| Phase | Name | Deterministic? | What it does |
|-------|------|---------------|--------------|
| **Pass 0** | Import Graph | ✅ | Builds the import/export graph for the codebase |
| **Pass 0-struct** | AST Structural | ✅ | Tree-sitter extracts symbols + structural edges (CALLS, EXTENDS, IMPLEMENTS, HAS_METHOD) for all supported languages |
| **Pass 0-flow** | Data Flow | ✅ | Deterministic TS/JS data-flow heuristics — tracks event emitters, pub/sub, config propagation, and producer/consumer patterns |
| **Pass 0.5** | Blurbs | ❌ | LLM generates concise one-line blurbs for each file |
| **Pass 1** | Deep Extraction | ❌ | LLM produces structured extraction — purpose, public API, patterns, hazards, conventions, key types, data flows, dependencies |
| **Embed** | Vectorize | ❌ | Stores vectors for semantic search |
| **Pass 2** | Cross-References | ✅ | Deterministic heuristic cross-ref computation — queries the symbols/references tables from pass0-struct + pass0-flow, falls back to ripgrep for uncovered symbols. Produces per-symbol call sites, usage counts, and blast radius ratings |
| **Pass 3** | Community Detection | ✅ | Leiden algorithm clusters files into hierarchical communities based on the structural edge graph. Produces named clusters like `pipeline/extraction` or `tools/query` |

### Deterministic-Only Mode

If no provider is configured, the pipeline skips passes 0.5, 1, and embed — but pass0-struct, pass0-flow, pass2, and pass3 all run, giving you structural symbols, edges, cross-references, and community clusters with zero API calls. Use `atlas_reindex phase=pass2` to recompute cross-references on demand.

### Response-Embedded Guidance

Tool responses include contextual `💡` hints based on the actual query results. For example:

- `atlas_lookup` on a file with critical blast radius → *"⚠️ This file has high blast radius symbols. Run `atlas_graph action=impact` before modifying."*
- `atlas_commit` after success → *"💡 If you changed exports or public API, run `atlas_admin action=flush` to refresh cross-references."*
- `atlas_audit action=gaps` finding dead exports → *"💡 Consider removing unused exports, or run `atlas_admin action=reindex phase=pass2` if cross-refs are stale."*

This makes the standalone MCP server self-guiding — no external orchestrator, hooks, or SOPs needed. The AI gets the right hint at the right moment, tailored to what it just found.

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
        "ATLAS_SOURCE_ROOT": "/path/to/your/codebase",
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
        "ATLAS_SOURCE_ROOT": "/path/to/your/codebase",
        "ATLAS_WORKSPACE": "your-workspace"
      }
    }
  }
}
```

### Deterministic-Only (No Provider)

```json
{
  "mcpServers": {
    "atlas": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/path/to/atlas-mcp-server",
      "env": {
        "ATLAS_SOURCE_ROOT": "/path/to/your/codebase"
      }
    }
  }
}
```

No API keys needed. Pass0-struct, pass0-flow, pass2, and pass3 all run deterministically. You get structural symbols, edges, cross-references, community clusters, and graph tools — just no blurbs, deep extractions, or embeddings.

## Configuration

### CLI Flags

| Flag | Purpose |
|------|---------|
| `--wizard` | Force the interactive setup flow |
| `--provider` | Choose `openai`, `anthropic`, `gemini`, or `ollama` |
| `--concurrency` | Set batch size for init runs |
| `--yes` | Skip interactive confirmation prompts |
| `--force` | Delete existing database and rebuild from scratch |
| `--phase pass2` | Run only pass 2 (cross-refs) during init |
| `--file <path>` | Target specific files during init (repeatable) |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ATLAS_SOURCE_ROOT` | Root directory of the codebase to index |
| `ATLAS_DB_PATH` | Path to the SQLite database (defaults to `<source_root>/.atlas/atlas.sqlite`) |
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

## Supported Languages

| Language | Extensions | AST Extraction | Flow Analysis |
|----------|-----------|----------------|---------------|
| TypeScript | `.ts` | ✅ Symbols, edges, exports | ✅ Data flows, event patterns |
| TSX | `.tsx` | ✅ | ✅ |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | ✅ | ✅ |
| Python | `.py` | ✅ Symbols, edges, exports | — |
| Go | `.go` | ✅ Symbols, edges, exports | — |
| Rust | `.rs` | ✅ Symbols, edges, exports | — |
| Java | `.java` | ✅ Symbols, edges, exports (with nested class support) | — |

All languages get structural AST extraction via tree-sitter (symbols, edges, exports). TypeScript and JavaScript additionally get deterministic data-flow analysis.

## Architecture

- **SQLite + sqlite-vec** — structured file knowledge, embeddings, changelogs, cross-references, symbols, references, and community clusters all in one portable database
- **Tree-sitter** — native AST parsing for 7 languages via lazy-loaded grammar singletons
- **Providers** — generate blurbs, extractions, and embeddings via OpenAI, Anthropic, Gemini, or Ollama
- **MCP server** — exposes all tools over stdio, compatible with any MCP client
- **`atlas://context` resource** — injects live codebase context into MCP clients automatically
- **File watcher** — detects changes and re-extracts modified files in real time
- **Bridge** — discovers sibling atlas databases on disk for cross-workspace search
- **Leiden clustering** — groups files into hierarchical communities based on structural edges for natural navigation

## License

MIT
