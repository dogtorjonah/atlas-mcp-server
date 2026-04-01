# @voxxo/atlas

**A codebase brain for any LLM.**

`@voxxo/atlas` indexes a TypeScript codebase into structured knowledge, serves that knowledge through MCP tools, and keeps the atlas fresh when you reindex or flush updated files.

## What It Does

- Indexes your codebase into a structured atlas with blurbs, deep extractions, embeddings, and cross-references.
- Serves the atlas through MCP tools so agents can search, inspect, and refresh code knowledge on demand.
- Auto-updates the atlas when you flush or reindex changes, so the knowledge layer stays current with the repo.

## Quick Start

```bash
git clone https://github.com/dogtorjonah/atlas-mcp-server.git
cd atlas-mcp-server
npm install
npx tsx src/server.ts init ./path/to/your/codebase
```

The init wizard walks you through the codebase path, workspace, provider, concurrency, and provider-specific credentials.

## Providers

- **OpenAI**: uses `gpt-5.4-mini` for blurbs and extraction, plus OpenAI embeddings.
- **Anthropic**: uses `claude-haiku-4-5` for chat work and the configured embedding path.
- **Gemini**: uses `gemini-3.1-flash` for text generation and `gemini-embedding-001` for embeddings.
- **Ollama**: local and free if you already have Ollama running.

## Tools

- `atlas_search` finds relevant files by semantic query.
- `atlas_lookup` returns the full atlas extraction for one file.
- `atlas_flush` refreshes stale atlas entries after file changes.
- `atlas_reindex` rebuilds atlas data for a workspace or target scope.

## MCP Client Setup

### Claude Code

```json
{
  "mcpServers": {
    "atlas": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/Users/administrator/atlas-mcp-server",
      "env": {
        "ATLAS_DB_PATH": "/Users/administrator/atlas-mcp-server/.atlas/atlas.sqlite",
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
      "cwd": "/Users/administrator/atlas-mcp-server",
      "env": {
        "ATLAS_DB_PATH": "/Users/administrator/atlas-mcp-server/.atlas/atlas.sqlite",
        "ATLAS_SOURCE_ROOT": "/path/to/your/codebase",
        "ATLAS_WORKSPACE": "your-workspace"
      }
    }
  }
}
```

## How It Works

The atlas pipeline runs in phases:

1. **Pass 0** builds the import graph for the codebase.
2. **Pass 0.5** generates concise blurbs for each file.
3. **Pass 1** produces deep structured extraction.
4. **Pass 2** adds cross-references and blast-radius analysis.
5. **Embed** stores vectors for semantic search.

Search uses hybrid BM25 + vector ranking so both keyword and semantic queries work well.

## Configuration

CLI flags:

- `--wizard` forces the interactive setup flow
- `--provider` chooses `openai`, `anthropic`, `gemini`, or `ollama`
- `--concurrency` sets batch size for init runs
- `--yes` skips interactive confirmation prompts

Environment variables:

- `ATLAS_DB_PATH`
- `ATLAS_SOURCE_ROOT`
- `ATLAS_WORKSPACE`
- `ATLAS_PROVIDER`
- `ATLAS_CONCURRENCY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `VOYAGE_API_KEY`
- `OLLAMA_BASE_URL`
- `ATLAS_SQLITE_VEC_EXTENSION`

## Architecture

Think of Atlas as a codebase brain:

- the database stores structured file knowledge
- the providers generate blurbs, extractions, and embeddings
- the MCP server exposes search and lookup tools
- the `atlas://context` resource can inject live codebase context into clients automatically

## License

MIT
