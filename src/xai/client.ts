// xAI Grok client: OpenAI-compatible /chat/completions with SSE streaming, abort and timeout.
import * as https from 'https';
import * as http from 'http';
import { SseParser, parseDelta, ToolCallAccumulator, ToolCall, StreamDelta } from './sse';

export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image_url'; image_url: { url: string } }
export type MessageContent = string | (TextPart | ImagePart)[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface RequestOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSpec[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** reasoning_effort for reasoning models (docs.x.ai/developers/model-capabilities/text/reasoning). Omitted when undefined. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Sent as x-grok-conv-id to route a conversation to the same server for prompt-cache hits. */
  convId?: string;
  /** Retries for 429/5xx/connection errors before any data arrived (default 3). */
  maxRetries?: number;
  /** Base backoff in ms (default 1000); tests use small values. */
  retryBaseMs?: number;
  /** Diagnostics hook (no key, no payload). */
  onRetry?: (info: { attempt: number; delayMs: number; kind: ApiErrorKind; status?: number }) => void;
}

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETDOWN']);

/** Parse Retry-After (seconds or HTTP date) into ms, capped at 60s. */
export function parseRetryAfter(v: string | string[] | undefined, now = Date.now()): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) { return undefined; }
  const n = Number(s);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(s) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

export function isRetryable(e: unknown): boolean {
  if (!(e instanceof GrokApiError)) { return false; }
  if (e.kind === 'rate_limit' || e.kind === 'server') { return true; }
  return e.kind === 'network' || e.kind === 'offline';
}

/** Exponential backoff with full jitter; Retry-After wins when given. */
export function backoffMs(attempt: number, baseMs: number, retryAfterMs?: number, rand = Math.random): number {
  if (retryAfterMs !== undefined) { return retryAfterMs; }
  const cap = Math.min(30_000, baseMs * 2 ** attempt);
  return Math.round(cap / 2 + rand() * cap / 2);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) { rej(new GrokApiError('Request cancelled.', 'aborted')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', on); res(); }, ms);
    const on = () => { clearTimeout(t); rej(new GrokApiError('Request cancelled.', 'aborted')); };
    signal?.addEventListener('abort', on, { once: true });
  });
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: StreamDelta['usage'];
  latencyMs: number;
}

export type ApiErrorKind = 'auth' | 'rate_limit' | 'missing_key' | 'quota_exceeded' | 'context_length' | 'aborted' | 'timeout' | 'network' | 'offline' | 'server' | 'generic';

export class GrokApiError extends Error {
  /** Server-requested delay (Retry-After), ms. */
  retryAfterMs?: number;
  /** Attempts made before giving up (set by postXai). */
  attempts?: number;
  constructor(message: string, public readonly kind: ApiErrorKind, public readonly statusCode?: number) {
    super(message);
    this.name = 'GrokApiError';
  }
}

export function classifyHttpError(status: number, body: string): GrokApiError {
  let msg = body;
  try { msg = JSON.parse(body)?.error?.message ?? JSON.parse(body)?.error ?? body; } catch { /* raw */ }
  if (typeof msg !== 'string') { msg = JSON.stringify(msg); }
  const l = msg.toLowerCase();
  if ((status === 401 || status === 403) && /credit|balance|quota|insufficient|exceeded/.test(l)) {
    return new GrokApiError(`xAI: out of credits or quota (${status}). ${msg}`, 'quota_exceeded', status);
  }
  if (status === 401 || status === 403) {
    return new GrokApiError(`xAI: authentication failed (${status}). Run "VSGrok: Set API Key". ${msg}`, 'auth', status);
  }
  if (status === 429) { return new GrokApiError(`xAI: rate limited (429). ${msg}`, 'rate_limit', status); }
  if (status === 400 && /context|maximum|too long|tokens/.test(l)) {
    return new GrokApiError(`xAI: request exceeds the model context window. ${msg}`, 'context_length', status);
  }
  if (status >= 500) { return new GrokApiError(`xAI server error (${status}). ${msg}`.trim(), 'server', status); }
  return new GrokApiError(`xAI API error (${status}): ${msg || 'unknown error'}`, 'generic', status);
}

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  convId?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; kind: ApiErrorKind; status?: number }) => void;
}

type RetryListener = (info: { path: string; attempt: number; delayMs: number; kind: ApiErrorKind; status?: number }) => void;
let retryListener: RetryListener | undefined;
/** Global hook for the diagnostics log. */
export function setRetryListener(l: RetryListener | undefined) { retryListener = l; }

/**
 * POST JSON to {baseUrl}{path}. If `onEvent` is given the response is parsed as SSE and each `data:` JSON is passed to it;
 * otherwise the full body is JSON-parsed and returned. Handles abort, idle timeout and HTTP error classification.
 */
export async function postXai(path: string, payload: unknown, t: TransportOptions, onEvent?: (evt: unknown) => void): Promise<unknown> {
  const max = Math.max(0, t.maxRetries ?? 3);
  for (let attempt = 0; ; attempt++) {
    const st = { gotData: false };
    try {
      return await postOnce(path, payload, t, onEvent, st);
    } catch (e) {
      // Never retry once streaming has started (events already delivered), on cancel, or non-transient errors.
      if (attempt >= max || st.gotData || !isRetryable(e) || t.signal?.aborted) {
        if (e instanceof GrokApiError) { e.attempts = attempt + 1; }
        throw e;
      }
      const ge = e as GrokApiError;
      const delayMs = backoffMs(attempt, t.retryBaseMs ?? 1000, ge.retryAfterMs);
      t.onRetry?.({ attempt: attempt + 1, delayMs, kind: ge.kind, status: ge.statusCode });
      retryListener?.({ path, attempt: attempt + 1, delayMs, kind: ge.kind, status: ge.statusCode });
      await sleep(delayMs, t.signal);
    }
  }
}

function postOnce(path: string, payload: unknown, t: TransportOptions, onEvent: ((evt: unknown) => void) | undefined, st: { gotData: boolean }): Promise<unknown> {
  if (!t.apiKey) {
    return Promise.reject(new GrokApiError('No xAI API key set. Run "VSGrok: Set API Key".', 'missing_key'));
  }
  const body = JSON.stringify(payload);
  const url = new URL(t.baseUrl.replace(/\/+$/, '') + path);
  const lib = url.protocol === 'http:' ? http : https;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; cleanup(); reject(e); } };
    const ok = (r: unknown) => { if (!settled) { settled = true; cleanup(); resolve(r); } };

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${t.apiKey}`,
        'Content-Type': 'application/json',
        Accept: onEvent ? 'text/event-stream' : 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(t.convId ? { 'x-grok-conv-id': t.convId } : {}),
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        let err = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (err += d));
        res.on('end', () => { const e = classifyHttpError(status, err); e.retryAfterMs = parseRetryAfter(res.headers['retry-after']); fail(e); });
        return;
      }
      if (onEvent) {
        const parser = new SseParser((evt) => { try { onEvent(evt); } catch (e) { req.destroy(); fail(e as Error); } });
        res.on('data', (c: Buffer) => { st.gotData = true; resetTimer(); parser.push(c); });
        res.on('end', () => { parser.end(); ok(undefined); });
      } else {
        let txt = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => { resetTimer(); txt += d; });
        res.on('end', () => { try { ok(JSON.parse(txt)); } catch { fail(new GrokApiError('xAI returned invalid JSON.', 'generic', status)); } });
      }
      res.on('error', (e) => fail(new GrokApiError(`Stream error: ${e.message}`, 'network')));
    });

    // Idle timeout: reset on every received chunk.
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = t.timeoutMs ?? 120000;
    const resetTimer = () => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(() => {
        req.destroy();
        fail(new GrokApiError(`xAI request timed out after ${Math.round(timeoutMs / 1000)}s of no data.`, 'timeout'));
      }, timeoutMs);
    };
    const onAbort = () => { req.destroy(); fail(new GrokApiError('Request cancelled.', 'aborted')); };
    const cleanup = () => { if (timer) { clearTimeout(timer); } t.signal?.removeEventListener('abort', onAbort); };

    if (t.signal?.aborted) { onAbort(); return; }
    t.signal?.addEventListener('abort', onAbort);
    resetTimer();
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) { return; }
      fail(OFFLINE_CODES.has(String(e.code))
        ? new GrokApiError(`Can't reach xAI (${e.code}). Check your internet connection or vsgrok.baseUrl.`, 'offline')
        : new GrokApiError(`Network error: ${e.message}`, 'network'));
    });
    req.write(body);
    req.end();
  });
}

/** Legacy Chat Completions streaming (vsgrok.api = "chat", and inline completions). */
export async function streamChat(messages: ChatMessage[], opts: RequestOptions): Promise<StreamResult> {
  const started = Date.now();
  const payload: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.temperature !== undefined) { payload.temperature = opts.temperature; }
  if (opts.maxTokens) { payload.max_tokens = opts.maxTokens; }
  if (opts.reasoningEffort) { payload.reasoning_effort = opts.reasoningEffort; }
  if (opts.tools?.length) { payload.tools = opts.tools; payload.tool_choice = 'auto'; }
  let content = '';
  let finishReason: string | undefined;
  let usage: StreamDelta['usage'];
  const acc = new ToolCallAccumulator();
  await postXai('/chat/completions', payload, opts, (evt) => {
    const d = parseDelta(evt);
    if (d.content) { content += d.content; opts.onContent?.(d.content); }
    if (d.reasoning) { opts.onReasoning?.(d.reasoning); }
    if (d.toolCalls) { acc.add(d.toolCalls); }
    if (d.finishReason) { finishReason = d.finishReason; }
    if (d.usage) { usage = d.usage; }
  });
  return { content, toolCalls: acc.result(), finishReason, usage, latencyMs: Date.now() - started };
}
