/**
 * Legacy: Ollama (local) LLM provider for extraction pipeline.
 *
 * Retained for optional use — not required in heuristic-only mode. When
 * configured, provides local blurb generation, deep extraction, and embeddings
 * without API costs. In the default heuristic-only pipeline, these capabilities
 * are replaced by organic enrichment via atlas_commit from working agents.
 */
import type {
  AtlasFileExtraction,
  AtlasKeyTypeEntry,
  AtlasPublicApiEntry,
  AtlasProvider,
  AtlasServerConfig,
} from '../types.js';

const OLLAMA_CHAT_MODEL = process.env.ATLAS_OLLAMA_MODEL || process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_EMBED_MODEL = process.env.ATLAS_OLLAMA_EMBED_MODEL || process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function notConfigured(message: string): never {
  throw new Error(message);
}

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizePublicApi(value: unknown): AtlasPublicApiEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) return [];
    return [{
      name,
      type: asString(record.type, 'function'),
      signature: typeof record.signature === 'string' ? record.signature : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
    }];
  });
}

function normalizeKeyTypes(value: unknown): AtlasKeyTypeEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) return [];
    return [{
      name,
      kind: asString(record.kind, 'unknown'),
      exported: typeof record.exported === 'boolean' ? record.exported : false,
      description: typeof record.description === 'string' ? record.description : undefined,
    }];
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []));
}

function normalizeExtraction(value: unknown): AtlasFileExtraction {
  if (!value || typeof value !== 'object') {
    return {
      purpose: '',
      public_api: [],
      exports: [],
      patterns: [],
      dependencies: {},
      data_flows: [],
      key_types: [],
      hazards: [],
      conventions: [],
    };
  }

  const record = value as Record<string, unknown>;
  const publicApi = normalizePublicApi(record.public_api);
  const exports = Array.isArray(record.exports)
    ? record.exports.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const entry = item as Record<string, unknown>;
        const name = asString(entry.name);
        if (!name) return [];
        return [{
          name,
          type: asString(entry.type, 'function'),
        }];
      })
    : publicApi.map((entry) => ({
        name: entry.name,
        type: entry.type,
      }));

  return {
    purpose: asString(record.purpose),
    public_api: publicApi,
    exports,
    patterns: normalizeStringArray(record.patterns),
    dependencies: record.dependencies && typeof record.dependencies === 'object'
      ? record.dependencies as Record<string, unknown>
      : {},
    data_flows: normalizeStringArray(record.data_flows),
    key_types: normalizeKeyTypes(record.key_types),
    hazards: normalizeStringArray(record.hazards),
    conventions: normalizeStringArray(record.conventions),
  };
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama ${resp.status}: ${text.slice(0, 400)}`);
  }

  return resp.json() as Promise<T>;
}

function readText(payload: { message?: { content?: string }; response?: string }): string {
  return (payload.message?.content ?? payload.response ?? '').trim();
}

export function createOllamaProvider(config: AtlasServerConfig): AtlasProvider {
  const baseUrl = config.ollamaBaseUrl.replace(/\/$/, '');
  const model = config.model?.trim() || OLLAMA_CHAT_MODEL;

  return {
    kind: 'ollama',
    async generateBlurb({ filePath, sourceText }): Promise<string> {
      const payload = await postJson<{
        message?: { content?: string };
        response?: string;
      }>(baseUrl, '/api/chat', {
        model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content: 'You are a senior software architect writing concise file summaries.',
          },
          {
            role: 'user',
            content: `Analyze this file and write a concise 2-3 sentence summary of its purpose, where it fits in the architecture, and what to watch out for when modifying it.\n\nFile: ${filePath}\n\n\`\`\`\n${sourceText.slice(0, 8000)}\n\`\`\`\n\nRespond with ONLY the summary text. No markdown, no headers.`,
          },
        ],
      });

      const text = readText(payload);
      if (!text) {
        throw new Error(`Ollama returned no blurb text for ${filePath}`);
      }
      return stripCodeFences(text);
    },
    async extractFile({ filePath, sourceText, blurb }): Promise<AtlasFileExtraction> {
      const payload = await postJson<{
        message?: { content?: string };
        response?: string;
      }>(baseUrl, '/api/chat', {
        model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content: 'You are a senior TypeScript architect performing deep code analysis. Output only JSON.',
          },
          {
            role: 'user',
            content: `Extract structured metadata from this TypeScript file. Context: ${blurb}\n\nFile: ${filePath}\n\n\`\`\`typescript\n${sourceText.slice(0, 12000)}\n\`\`\`\n\nReturn a JSON object with these fields:\n- purpose (string): what this file does\n- public_api (array): each export with {name, type, signature, description}\n- patterns (array of strings): architectural patterns used\n- dependencies (object): {imports: string[], imported_by: string[]}\n- data_flows (array of strings): how data moves through this file\n- key_types (array): important types with {name, kind, exported, description}\n- hazards (array of strings): risks when modifying this file\n- conventions (array of strings): code conventions used\n\nOutput ONLY valid JSON.`,
          },
        ],
      });

      const text = stripCodeFences(readText(payload));
      return normalizeExtraction(JSON.parse(text));
    },
    async embedText(text: string): Promise<number[]> {
      const payload = await postJson<{ embedding?: number[] }>(baseUrl, '/api/embeddings', {
        model: OLLAMA_EMBED_MODEL,
        prompt: text.slice(0, 8000),
      });

      if (Array.isArray(payload.embedding) && payload.embedding.length > 0) {
        return payload.embedding;
      }
      throw new Error('Ollama returned no embedding vector');
    },
    async extractCrossRefs({ sourceText }): Promise<unknown> {
      if (!sourceText) return null;

      const payload = await postJson<{
        message?: { content?: string };
        response?: string;
      }>(baseUrl, '/api/chat', {
        model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content: 'You are a senior TypeScript architect analyzing cross-file symbol usage. Output ONLY valid JSON: one key per symbol name, each with { "type": string, "call_sites": [{ "file": string, "usage_type": string, "count": number, "context": string }], "total_usages": number, "blast_radius": "local"|"narrow"|"moderate"|"broad" }',
          },
          {
            role: 'user',
            content: sourceText,
          },
        ],
      });

      const text = stripCodeFences(readText(payload));
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}
