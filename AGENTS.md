# Atlas MCP Server

Deterministic codebase intelligence server. Builds a structured, searchable index from AST analysis, import graphs, cross-references, and Leiden community clustering. No LLM calls, no API keys.

## Atlas Is Your Primary Tool — Use It Before Grep, Read, or Search

**Atlas tools replace raw file exploration.** Do NOT grep, rg, or read files blind. The atlas already knows what every file does, what it exports, what depends on it, and what patterns it uses.

| Instead of... | Use... |
|---------------|--------|
| `grep` / `rg` for a concept | `atlas_query action=search query="concept"` |
| `Read` to understand a file | `atlas_query action=lookup file_path="..."` |
| `Read` multiple files for planning | `atlas_query action=plan_context query="task"` |
| `git log` to check recent changes | `atlas_query action=history file_path="..."` |
| `find` / `glob` for related files | `atlas_query action=similar file_path="..."` |
| Guessing blast radius of a change | `atlas_graph action=impact file_path="..."` |

**Only drop to raw code reads AFTER the atlas tells you which files and which lines matter.**

## Tools

| Tool | Purpose |
|------|---------|
| `atlas_query` | **Your #1 tool.** Retrieval: search, lookup, brief, snippet, similar, plan_context, cluster, patterns, history |
| `atlas_graph` | Topology: impact, neighbors, trace, cycles, reachability, graph |
| `atlas_audit` | Quality: gaps (including `incomplete_atlas_entry`), smells, hotspots |
| `atlas_admin` | Operations: bridge_list, reindex, flush |
| `atlas_commit` | Post-edit writeback — enriches the atlas with agent knowledge |

## atlas_commit — How to Use It Right

`atlas_commit` is how agents populate the atlas with semantic knowledge. The pipeline gives you structure (AST, imports, cross-refs). Agents give it meaning (purpose, hazards, patterns).

**Required:** Every call must include at least one structured metadata field. Summary-only calls are rejected.

**Structured fields (fill as many as you can):**
- `purpose` — 1-2 sentences. What the file does and why.
- `blurb` — Under 80 chars. Used in search results and compact listings.
- `patterns` — Architectural patterns: facade, middleware, observer, registry, etc.
- `hazards` — Correctness risks: race conditions, silent failures, mutation traps.
- `conventions` — Project conventions this file follows or establishes.
- `key_types` — Important types/interfaces downstream consumers depend on.
- `data_flows` — How data moves through the file: inputs, transforms, outputs.
- `public_api` — Exported functions/classes with name, type, optional signature.
- `source_highlights` — 2-5 most important code sections. Skip boilerplate.

**Coverage enforcement:** After every commit, the tool reports coverage as a percentage of 9 tracked fields. Below 50% gets a loud warning. At minimum: `purpose` + `blurb` + `hazards` + `patterns`.

**File claims (multi-agent safety):** When multiple agents enrich in parallel, atlas_commit acquires an in-memory lock on `(workspace, file_path)`. If another agent holds the claim, your call returns a conflict with the holder ID and retry timing. Claims auto-expire after 30s. For best results, partition agents by cluster.

## Pipeline Phases

```
scan → structure → flow → community → crossref
```

All deterministic. Semantic fields start empty — populated by agents via `atlas_commit`.

## Build & Dev

```bash
npm install
npm run build          # tsc + copy prompts
npx tsc --noEmit       # Type-check only
```

## Architecture

```
src/
  server.ts            — MCP server entry point + tool registration
  db.ts                — SQLite database layer (atlas.sqlite)
  types.ts             — Core type definitions
  tools/               — All MCP tool handlers (one per tool)
    query.ts           — atlas_query composite router
    graphComposite.ts  — atlas_graph composite router
    audit.ts           — atlas_audit composite router
    commit.ts          — atlas_commit handler with file claims + coverage
    admin.ts           — atlas_admin handler
    reindex.ts         — Reindex orchestration
    gaps.ts            — Gap detection (5 types incl. incomplete_atlas_entry)
    ...                — Individual action handlers
  pipeline/            — Deterministic extraction pipeline
migrations/            — SQLite schema migrations
.atlas/
  atlas.sqlite         — Runtime store (SQLite + FTS5)
```

## Coding Conventions

- **ESM throughout** — imports use `.js` extensions
- **TypeScript strict** — no `any` without justification
- **Zod schemas** for all tool parameter validation
- **`toolWithDescription`** helper for tool registration with rich descriptions
- **Composite tools** route `action` param to individual handler functions
