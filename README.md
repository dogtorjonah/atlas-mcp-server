# Atlas MCP Server

A codebase intelligence server that builds a structured, searchable index of your codebase using deterministic analysis — no API key required.

## How It Works

Atlas runs a multi-phase pipeline to understand your codebase:

1. **Scan** — File discovery, regex-based import/export extraction, import graph construction, cluster assignment
2. **Structure** — Tree-sitter AST analysis: symbol definitions, CALLS/EXTENDS/IMPLEMENTS/HAS_METHOD edges
3. **Flow** — Import graph data flow analysis
4. **Community** — Leiden-based cluster detection from the import graph
5. **Cross-references** — Structural cross-file reference analysis

All phases are fully deterministic and heuristic — no LLM calls, no API key, no cost.

## Organic Growth via `atlas_commit`

The schema includes rich metadata fields — `purpose`, `blurb`, `public_api`, `patterns`, `hazards`, `conventions`, `key_types`, `data_flows`, `source_highlights` — that **start empty** after the initial pipeline run.

These fields are populated **organically by agents** as they work with the codebase. When an agent edits or reviews a file, it calls `atlas_commit` to write back what it learned. The agent that just modified the code has maximum context — its metadata is higher quality than any cold extraction pass.

**The more you use Atlas, the smarter it gets.** Each `atlas_commit` enriches the index, improves BM25 search results, and helps future agents orient faster.

### AI-Curated Source Highlights

Instead of naively truncating source code at a line limit, agents curate the most important code sections during `atlas_commit`. Each highlight is a numbered, labeled snippet that can represent disjointed segments from anywhere in the file.

For a 2000-line file, an agent might select 3 key segments — the main export, the error handling, and the config parsing — skipping boilerplate entirely. Changelog entries can reference snippets by number ("refer to snippet 5").

When curated highlights exist, `atlas_query action=lookup` shows those instead of raw source. When no highlights exist yet, it falls back to adaptive raw source display (more code when metadata is sparse, less when metadata tells the story).

## Search

Atlas provides BM25 full-text search via SQLite FTS5. Results are ranked by relevance against file purposes, patterns, descriptions, and export names. Search quality improves automatically as agents fill in metadata via `atlas_commit` — the index uses the codebase's own vocabulary.

## Tools

| Tool | Purpose |
|------|---------|
| `atlas_query` | Composite retrieval: search, lookup, brief, snippet, similar, plan_context, cluster, patterns, history |
| `atlas_graph` | Topology analysis: impact, neighbors, trace, cycles, reachability, graph |
| `atlas_audit` | Quality scans: gaps, smells, hotspots |
| `atlas_admin` | Operations: bridge_list, reindex, flush |
| `atlas_commit` | Post-edit writeback: records change rationale and updates file metadata |

## Quick Start

```bash
# Install
npm install

# Initialize the atlas for your codebase (no API key needed)
npx atlas-mcp-server init --source-root /path/to/your/project

# Run as MCP server
npx atlas-mcp-server
```

## Configuration

Atlas reads configuration from environment variables or CLI flags:

| Variable | Purpose | Required |
|----------|---------|----------|
| `ATLAS_SOURCE_ROOT` | Path to your codebase | Yes (or `--source-root`) |
| `ATLAS_WORKSPACE` | Workspace name (defaults to directory basename) | No |

**No API key required.** The entire pipeline is deterministic and heuristic.

## Architecture

```
.atlas/
  atlas.sqlite    — Runtime atlas store (SQLite + FTS5)

Pipeline phases:
  scan -> structure -> flow -> community -> crossref

Search:
  BM25 full-text search via FTS5 over all metadata fields
```

## Data Model

Each file in the atlas has:

| Field | Source | Description |
|-------|--------|-------------|
| `file_path` | scan | Relative path from source root |
| `cluster` | scan + community | Logical grouping |
| `loc` | scan | Lines of code |
| `imports` / `imported_by` | scan | Import graph edges |
| `exports` | scan | Exported symbols (name + type) |
| `symbols` | structure | AST-extracted symbol definitions |
| `purpose` | atlas_commit | What the file does (filled by agents) |
| `blurb` | atlas_commit | Short description for search (filled by agents) |
| `public_api` | atlas_commit | Exported API with descriptions (filled by agents) |
| `patterns` | atlas_commit | Architectural patterns (filled by agents) |
| `hazards` | atlas_commit | Known risks and gotchas (filled by agents) |
| `conventions` | atlas_commit | Coding conventions (filled by agents) |
| `key_types` | atlas_commit | Important type definitions (filled by agents) |
| `data_flows` | atlas_commit | Data flow descriptions (filled by agents) |
| `source_highlights` | atlas_commit | AI-curated code snippets — disjointed, numbered, labeled (filled by agents) |
