import type {
  AtlasFileExtraction,
  AtlasKeyTypeEntry,
  AtlasPublicApiEntry,
  AtlasProvider,
  AtlasServerConfig,
} from '../types.js';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const VOYAGE_MODEL = 'voyage-3-small';
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

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
  const resp = await fetch(`${ANTHROPIC_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 400)}`);
  }

  return resp.json() as Promise<T>;
}

function extractText(payload: { content?: Array<{ type?: string; text?: string }> }): string {
  return payload.content
    ?.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('')
    .trim() ?? '';
}

function extractToolInput(payload: { content?: Array<{ type?: string; input?: unknown }> }): unknown {
  const toolBlock = payload.content?.find((part) => part.type === 'tool_use');
  return toolBlock?.input;
}

async function maybeVoyageEmbedding(config: AtlasServerConfig, text: string): Promise<number[] | null> {
  if (!config.voyageApiKey) {
    return null;
  }

  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.voyageApiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: text.slice(0, 8000),
    }),
  });

  if (!resp.ok) {
    const textBody = await resp.text();
    throw new Error(`Voyage ${resp.status}: ${textBody.slice(0, 400)}`);
  }

  const payload = await resp.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (Array.isArray(embedding) && embedding.length > 0) {
    return embedding;
  }
  return null;
}

async function openAIEmbedding(config: AtlasServerConfig, text: string): Promise<number[]> {
  if (!config.openAiApiKey) {
    notConfigured('OPENAI_API_KEY or VOYAGE_API_KEY is required for the Anthropic embedding path');
  }

  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openAiApiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    }),
  });

  if (!resp.ok) {
    const textBody = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${textBody.slice(0, 400)}`);
  }

  const payload = await resp.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('OpenAI returned no embedding vector');
  }
  return embedding;
}

export function createAnthropicProvider(config: AtlasServerConfig): AtlasProvider {
  const apiKey = config.anthropicApiKey;

  return {
    kind: 'anthropic',
    async generateBlurb({ filePath, sourceText }): Promise<string> {
      if (!apiKey) {
        notConfigured('ANTHROPIC_API_KEY is required for the Anthropic atlas provider');
      }

      const payload = await postJson<{
        content?: Array<{ type?: string; text?: string }>;
      }>(apiKey, '/messages', {
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        temperature: 0.1,
        system: 'You are a senior TypeScript architect writing concise file summaries.',
        messages: [
          {
            role: 'user',
            content: `Analyze this TypeScript file and write a concise 2-3 sentence summary of its purpose, where it fits in the architecture, and what to watch out for when modifying it.\n\nFile: ${filePath}\n\n\`\`\`typescript\n${sourceText.slice(0, 8000)}\n\`\`\`\n\nRespond with ONLY the summary text. No markdown, no headers.`,
          },
        ],
      } as Record<string, unknown>);

      const text = extractText(payload);
      if (!text) {
        throw new Error(`Anthropic returned no blurb text for ${filePath}`);
      }
      return text;
    },
    async extractFile({ filePath, sourceText, blurb }): Promise<AtlasFileExtraction> {
      if (!apiKey) {
        notConfigured('ANTHROPIC_API_KEY is required for the Anthropic atlas provider');
      }

      const payload = await postJson<{
        content?: Array<{ type?: string; input?: unknown }>;
      }>(apiKey, '/messages', {
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: 'You are a senior TypeScript architect performing deep code analysis. Use the provided tool exactly once.',
        messages: [
          {
            role: 'user',
            content: `Extract structured metadata from this TypeScript file. Context: ${blurb}\n\nFile: ${filePath}\n\n\`\`\`typescript\n${sourceText.slice(0, 12000)}\n\`\`\`\n\nReturn the file metadata via the tool call.`,
          },
        ],
        tools: [{
          name: 'extract_file',
          description: 'Return structured metadata for one TypeScript file.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              purpose: { type: 'string' },
              public_api: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    signature: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              exports: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                  },
                  required: ['name', 'type'],
                },
              },
              patterns: { type: 'array', items: { type: 'string' } },
              dependencies: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  imports: { type: 'array', items: { type: 'string' } },
                  imported_by: { type: 'array', items: { type: 'string' } },
                },
              },
              data_flows: { type: 'array', items: { type: 'string' } },
              key_types: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    kind: { type: 'string' },
                    exported: { type: 'boolean' },
                    description: { type: 'string' },
                  },
                  required: ['name', 'kind', 'exported'],
                },
              },
              hazards: { type: 'array', items: { type: 'string' } },
              conventions: { type: 'array', items: { type: 'string' } },
            },
            required: ['purpose', 'public_api', 'patterns', 'dependencies', 'data_flows', 'key_types', 'hazards', 'conventions'],
          },
        }],
        tool_choice: {
          type: 'tool',
          name: 'extract_file',
        },
      } as Record<string, unknown>);

      const input = extractToolInput(payload);
      return normalizeExtraction(input);
    },
    async embedText(text: string): Promise<number[]> {
      const voyageEmbedding = await maybeVoyageEmbedding(config, text);
      if (voyageEmbedding) {
        return voyageEmbedding;
      }
      return openAIEmbedding(config, text);
    },
    async extractCrossRefs({ sourceText }): Promise<unknown> {
      if (!apiKey) {
        notConfigured('ANTHROPIC_API_KEY is required for the Anthropic atlas provider');
      }

      if (!sourceText) return null;

      const payload = await postJson<{
        content?: Array<{ type?: string; input?: unknown }>;
      }>(apiKey, '/messages', {
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        temperature: 0,
        system: 'You are a senior TypeScript architect analyzing cross-file symbol usage. You will receive a file\'s exported symbols with tiered caller context. Use the provided tool exactly once to return cross-reference data for all symbols.',
        messages: [
          {
            role: 'user',
            content: sourceText,
          },
        ],
        tools: [{
          name: 'extract_cross_refs',
          description: 'Return cross-reference data for all exported symbols in the file.',
          input_schema: {
            type: 'object',
            additionalProperties: true,
            description: 'Keys are symbol names. Each value describes how that symbol is used across the codebase.',
            patternProperties: {
              '.*': {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string' },
                  call_sites: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        file: { type: 'string' },
                        usage_type: { type: 'string' },
                        count: { type: 'number' },
                        context: { type: 'string' },
                      },
                      required: ['file', 'usage_type', 'count', 'context'],
                    },
                  },
                  total_usages: { type: 'number' },
                  blast_radius: { type: 'string', enum: ['local', 'narrow', 'moderate', 'broad'] },
                },
                required: ['type', 'call_sites', 'total_usages', 'blast_radius'],
              },
            },
          },
        }],
        tool_choice: { type: 'tool', name: 'extract_cross_refs' },
      } as Record<string, unknown>);

      return extractToolInput(payload);
    },
  };
}
