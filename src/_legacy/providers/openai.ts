/**
 * Legacy: OpenAI LLM provider for extraction pipeline.
 *
 * Retained for optional use — not required in heuristic-only mode. When
 * configured, provides blurb generation, deep extraction, and embeddings.
 * In the default heuristic-only pipeline, these capabilities are replaced by
 * organic enrichment via atlas_commit from working agents.
 */
import type {
  AtlasFileExtraction,
  AtlasKeyTypeEntry,
  AtlasPublicApiEntry,
  AtlasProvider,
  AtlasServerConfig,
} from '../types.js';

const OPENAI_CHAT_MODEL = 'gpt-5.4-mini';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

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

async function postJson<T>(apiKey: string, path: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${OPENAI_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 400)}`);
  }

  return resp.json() as Promise<T>;
}

function extractAssistantText(payload: { choices?: Array<{ message?: { content?: unknown } }> }): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? [record.text] : [];
    }).join('').trim();
  }
  return '';
}

export function createOpenAIProvider(config: AtlasServerConfig): AtlasProvider {
  const apiKey = config.openAiApiKey;
  const model = config.model?.trim() || OPENAI_CHAT_MODEL;

  return {
    kind: 'openai',
    async generateBlurb({ filePath, sourceText }): Promise<string> {
      if (!apiKey) {
        notConfigured('OPENAI_API_KEY is required for the OpenAI atlas provider');
      }

      const payload = await postJson<{
        choices?: Array<{ message?: { content?: unknown } }>;
      }>(apiKey, '/chat/completions', {
        model,
        temperature: 0.1,
        max_completion_tokens: 256,
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

      const text = extractAssistantText(payload);
      if (!text) {
        throw new Error(`OpenAI returned no blurb text for ${filePath}`);
      }
      return text;
    },
    async extractFile({ filePath, sourceText, blurb }): Promise<AtlasFileExtraction> {
      if (!apiKey) {
        notConfigured('OPENAI_API_KEY is required for the OpenAI atlas provider');
      }

      const payload = await postJson<{
        choices?: Array<{ message?: { content?: unknown } }>;
      }>(apiKey, '/chat/completions', {
        model,
        temperature: 0,
        max_completion_tokens: 8192,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a senior TypeScript architect performing deep code analysis. Output ONLY valid JSON.',
          },
          {
            role: 'user',
            content: `Extract structured metadata from this TypeScript file. Context: ${blurb}\n\nFile: ${filePath}\n\n\`\`\`typescript\n${sourceText.slice(0, 12000)}\n\`\`\`\n\nReturn a JSON object with these fields:\n- purpose (string): what this file does\n- public_api (array): each export with {name, type, signature, description}\n- patterns (array of strings): architectural patterns used\n- dependencies (object): {imports: string[], imported_by: string[]}\n- data_flows (array of strings): how data moves through this file\n- key_types (array): important types with {name, kind, exported, description}\n- hazards (array of strings): risks when modifying this file\n- conventions (array of strings): code conventions used\n\nOutput ONLY valid JSON.`,
          },
        ],
      });

      const text = stripCodeFences(extractAssistantText(payload));
      return normalizeExtraction(JSON.parse(text));
    },
    async embedText(text: string): Promise<number[]> {
      if (!apiKey) {
        notConfigured('OPENAI_API_KEY is required for the OpenAI atlas provider');
      }

      const payload = await postJson<{
        data?: Array<{ embedding?: number[] }>;
      }>(apiKey, '/embeddings', {
        model: OPENAI_EMBEDDING_MODEL,
        input: text.slice(0, 8000),
      });

      const embedding = payload.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('OpenAI returned no embedding vector');
      }
      return embedding;
    },
    async extractCrossRefs({ sourceText }): Promise<unknown> {
      if (!apiKey) {
        notConfigured('OPENAI_API_KEY is required for the OpenAI atlas provider');
      }

      if (!sourceText) return null;

      const payload = await postJson<{
        choices?: Array<{ message?: { content?: unknown } }>;
      }>(apiKey, '/chat/completions', {
        model,
        temperature: 0,
        max_completion_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a senior TypeScript architect analyzing cross-file symbol usage. You will receive a file\'s exported symbols with tiered caller context (same-dir callers shown in full, near callers with blurb+snippet, far callers with snippet only). Output ONLY valid JSON: one key per symbol name, each with { "type": string, "call_sites": [{ "file": string, "usage_type": string, "count": number, "context": string }], "total_usages": number, "blast_radius": "local"|"narrow"|"moderate"|"broad" }',
          },
          {
            role: 'user',
            content: sourceText,
          },
        ],
      });

      const text = stripCodeFences(extractAssistantText(payload));
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}
