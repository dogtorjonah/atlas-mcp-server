import type {
  AtlasFileExtraction,
  AtlasKeyTypeEntry,
  AtlasPublicApiEntry,
  AtlasProvider,
  AtlasServerConfig,
} from '../types.js';

const GEMINI_TEXT_MODEL = 'gemini-3.1-flash';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

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
  const resp = await fetch(`${GEMINI_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${text.slice(0, 400)}`);
  }

  return resp.json() as Promise<T>;
}

function extractText(payload: {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}): string {
  return payload.candidates?.[0]?.content?.parts
    ?.flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
    .join('')
    .trim() ?? '';
}

export function createGeminiProvider(config: AtlasServerConfig): AtlasProvider {
  const apiKey = config.geminiApiKey;
  const model = config.model?.trim() || GEMINI_TEXT_MODEL;

  return {
    kind: 'gemini',
    async generateBlurb({ filePath, sourceText }): Promise<string> {
      if (!apiKey) {
        notConfigured('GEMINI_API_KEY is required for the Gemini atlas provider');
      }

      const payload = await postJson<{
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      }>(apiKey, `/models/${model}:generateContent`, {
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'text/plain',
        },
        contents: [{
          role: 'user',
          parts: [{
            text: `Analyze this TypeScript file and write a concise 2-3 sentence summary of its purpose, where it fits in the architecture, and what to watch out for when modifying it.\n\nFile: ${filePath}\n\n\`\`\`typescript\n${sourceText.slice(0, 8000)}\n\`\`\`\n\nRespond with ONLY the summary text. No markdown, no headers.`,
          }],
        }],
      });

      const text = extractText(payload);
      if (!text) {
        throw new Error(`Gemini returned no blurb text for ${filePath}`);
      }
      return text;
    },
    async extractFile({ filePath, sourceText, blurb }): Promise<AtlasFileExtraction> {
      if (!apiKey) {
        notConfigured('GEMINI_API_KEY is required for the Gemini atlas provider');
      }

      const payload = await postJson<{
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      }>(apiKey, `/models/${model}:generateContent`, {
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
        contents: [{
          role: 'user',
          parts: [{
            text: `Extract structured metadata from this TypeScript file. Context: ${blurb}\n\nFile: ${filePath}\n\n\`\`\`typescript\n${sourceText.slice(0, 12000)}\n\`\`\`\n\nReturn a JSON object with these fields:\n- purpose (string): what this file does\n- public_api (array): each export with {name, type, signature, description}\n- patterns (array of strings): architectural patterns used\n- dependencies (object): {imports: string[], imported_by: string[]}\n- data_flows (array of strings): how data moves through this file\n- key_types (array): important types with {name, kind, exported, description}\n- hazards (array of strings): risks when modifying this file\n- conventions (array of strings): code conventions used\n\nOutput ONLY valid JSON.`,
          }],
        }],
      });

      const text = stripCodeFences(extractText(payload));
      return normalizeExtraction(JSON.parse(text));
    },
    async embedText(text: string): Promise<number[]> {
      if (!apiKey) {
        notConfigured('GEMINI_API_KEY is required for the Gemini atlas provider');
      }

      const payload = await postJson<{
        embedding?: { values?: number[] };
      }>(apiKey, `/models/${GEMINI_EMBED_MODEL}:embedContent`, {
        content: {
          parts: [{
            text: text.slice(0, 8000),
          }],
        },
      });

      const embedding = payload.embedding?.values;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('Gemini returned no embedding vector');
      }
      return embedding;
    },
    async extractCrossRefs({ sourceText }): Promise<unknown> {
      if (!apiKey) {
        notConfigured('GEMINI_API_KEY is required for the Gemini atlas provider');
      }

      if (!sourceText) return null;

      const payload = await postJson<{
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      }>(apiKey, `/models/${model}:generateContent`, {
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
        contents: [{
          role: 'user',
          parts: [{
            text: `You are a senior TypeScript architect analyzing cross-file symbol usage. You will receive a file's exported symbols with tiered caller context (same-dir callers shown in full, near callers with blurb+snippet, far callers with snippet only).\n\n${sourceText}\n\nOutput ONLY valid JSON: one key per symbol name, each with { "type": string, "call_sites": [{ "file": string, "usage_type": string, "count": number, "context": string }], "total_usages": number, "blast_radius": "local"|"narrow"|"moderate"|"broad" }`,
          }],
        }],
      });

      const text = stripCodeFences(extractText(payload));
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}
