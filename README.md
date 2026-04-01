# @voxxo/atlas

Standalone MCP server for the Voxxo codebase atlas.

## Status

This package is scaffolded and defines:

- the SQLite schema shape
- the MCP server entry point
- tool and pipeline module boundaries
- provider abstraction stubs
- an MCP resource for auto-updated codebase context

## Scripts

```bash
npm run dev
npm run build
npm run check
```

## Environment

- `ATLAS_DB_PATH` - SQLite database file path
- `ATLAS_SOURCE_ROOT` - codebase root to index
- `ATLAS_PROVIDER` - `openai`, `anthropic`, or `ollama`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OLLAMA_BASE_URL`
- `ATLAS_SQLITE_VEC_EXTENSION` - optional sqlite-vec extension path
