// Live model discovery via GET {baseUrl}/models (https://docs.x.ai/developers/rest-api-reference/inference/models.md).
export interface ModelInfo { id: string; contextLength?: number; reasoning?: boolean }

/** Used when there is no key, the request fails, or it returns nothing usable. Ids from https://docs.x.ai/developers/models.md (Oct 2026). */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'grok-4.7' }, { id: 'grok-4.6' }, { id: 'grok-4.5' }, { id: 'grok-4.3' },
  { id: 'grok-4.20-0309-reasoning' }, { id: 'grok-4.20-0309-non-reasoning' }, { id: 'grok-build-0.1' },
];

const NON_CHAT = /(imagine|image|video|voice|embed|tts|whisper)/i;

/** Parse an xAI /models response into chat-capable models, newest first. Exported for tests. */
export function parseModels(json: unknown): ModelInfo[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) { return []; }
  const out: (ModelInfo & { created: number })[] = [];
  for (const m of data) {
    const id = (m as { id?: unknown })?.id;
    if (typeof id !== 'string' || !/^[\w.:-]{1,80}$/.test(id) || NON_CHAT.test(id)) { continue; }
    const r = m as { context_length?: unknown; created?: unknown; capabilities?: { reasoning_effort?: unknown } };
    out.push({
      id,
      contextLength: typeof r.context_length === 'number' ? r.context_length : undefined,
      reasoning: Array.isArray(r.capabilities?.reasoning_effort) && r.capabilities.reasoning_effort.length > 0,
      created: typeof r.created === 'number' ? r.created : 0,
    });
  }
  out.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  return out.map(m => ({ id: m.id, contextLength: m.contextLength, reasoning: m.reasoning }));
}

export async function fetchModels(baseUrl: string, apiKey: string, timeoutMs = 8000): Promise<ModelInfo[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    return parseModels(await res.json());
  } finally { clearTimeout(t); }
}

export interface ModelList { models: ModelInfo[]; source: 'live' | 'cache' | 'fallback'; error?: string }

interface Store { get<T>(k: string): T | undefined; update(k: string, v: unknown): PromiseLike<void> }
const CACHE_KEY = 'vsgrok.modelCache';
const TTL = 60 * 60 * 1000;

/** Live list (cached for an hour per base URL), falling back to cache then to FALLBACK_MODELS. */
export async function listModels(store: Store, baseUrl: string, apiKey: string, force = false): Promise<ModelList> {
  const c = store.get<{ at: number; baseUrl: string; models: ModelInfo[] }>(CACHE_KEY);
  const valid = c && c.baseUrl === baseUrl && c.models.length > 0;
  if (valid && !force && Date.now() - c.at < TTL) { return { models: c.models, source: 'cache' }; }
  if (!apiKey) { return valid ? { models: c.models, source: 'cache' } : { models: FALLBACK_MODELS, source: 'fallback', error: 'No API key set' }; }
  try {
    const models = await fetchModels(baseUrl, apiKey);
    if (!models.length) { throw new Error('empty model list'); }
    await store.update(CACHE_KEY, { at: Date.now(), baseUrl, models });
    return { models, source: 'live' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return valid ? { models: c.models, source: 'cache', error } : { models: FALLBACK_MODELS, source: 'fallback', error };
  }
}
