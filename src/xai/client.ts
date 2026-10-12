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
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: StreamDelta['usage'];
  latencyMs: number;
}

export type ApiErrorKind = 'auth' | 'rate_limit' | 'missing_key' | 'quota_exceeded' | 'context_length' | 'aborted' | 'timeout' | 'network' | 'generic';

export class GrokApiError extends Error {
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
  return new GrokApiError(`xAI API error (${status}): ${msg || 'unknown error'}`, 'generic', status);
}

export function streamChat(messages: ChatMessage[], opts: RequestOptions): Promise<StreamResult> {
  if (!opts.apiKey) {
    return Promise.reject(new GrokApiError('No xAI API key set. Run "VSGrok: Set API Key".', 'missing_key'));
  }
  const started = Date.now();
  const payload: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.temperature !== undefined) { payload.temperature = opts.temperature; }
  if (opts.maxTokens) { payload.max_tokens = opts.maxTokens; }
  if (opts.tools?.length) { payload.tools = opts.tools; payload.tool_choice = 'auto'; }
  const body = JSON.stringify(payload);
  const url = new URL(opts.baseUrl.replace(/\/+$/, '') + '/chat/completions');
  const lib = url.protocol === 'http:' ? http : https;

  return new Promise<StreamResult>((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; cleanup(); reject(e); } };
    const ok = (r: StreamResult) => { if (!settled) { settled = true; cleanup(); resolve(r); } };

    let content = '';
    let finishReason: string | undefined;
    let usage: StreamDelta['usage'];
    const acc = new ToolCallAccumulator();

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        let err = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (err += d));
        res.on('end', () => fail(classifyHttpError(status, err)));
        return;
      }
      const parser = new SseParser((evt) => {
        const d = parseDelta(evt);
        if (d.content) { content += d.content; opts.onContent?.(d.content); }
        if (d.toolCalls) { acc.add(d.toolCalls); }
        if (d.finishReason) { finishReason = d.finishReason; }
        if (d.usage) { usage = d.usage; }
      });
      res.on('data', (c: Buffer) => { resetTimer(); parser.push(c); });
      res.on('end', () => { parser.end(); ok({ content, toolCalls: acc.result(), finishReason, usage, latencyMs: Date.now() - started }); });
      res.on('error', (e) => fail(new GrokApiError(`Stream error: ${e.message}`, 'network')));
    });

    // Idle timeout: reset on every received chunk.
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = opts.timeoutMs ?? 120000;
    const resetTimer = () => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(() => {
        req.destroy();
        fail(new GrokApiError(`xAI request timed out after ${Math.round(timeoutMs / 1000)}s of no data.`, 'timeout'));
      }, timeoutMs);
    };
    const onAbort = () => { req.destroy(); fail(new GrokApiError('Request cancelled.', 'aborted')); };
    const cleanup = () => { if (timer) { clearTimeout(timer); } opts.signal?.removeEventListener('abort', onAbort); };

    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort);
    resetTimer();
    req.on('error', (e) => fail(settled ? e : new GrokApiError(`Network error: ${e.message}`, 'network')));
    req.write(body);
    req.end();
  });
}
