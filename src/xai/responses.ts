// xAI Responses API (POST /v1/responses) with SSE streaming.
// Docs: https://docs.x.ai/developers/rest-api-reference/inference/responses
//       https://docs.x.ai/developers/model-capabilities/text/generate-text
import { postXai, TransportOptions, GrokApiError } from './client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** An item of the Responses `input` array. Output items are passed back verbatim, so this stays open-ended. */
export type InputItem = Record<string, any>;

/** Client-side function tool, Responses shape: {type, name, description, parameters}. */
export interface FunctionTool { type: 'function'; name: string; description: string; parameters: object }
/** Built-in server-side tools (docs.x.ai/developers/tools/overview). */
export type ServerTool =
  | { type: 'web_search'; filters?: { allowed_domains?: string[]; excluded_domains?: string[] }; enable_image_understanding?: boolean }
  | { type: 'x_search'; allowed_x_handles?: string[]; excluded_x_handles?: string[]; from_date?: string; to_date?: string }
  | { type: 'code_interpreter' };
export type ResponseTool = FunctionTool | ServerTool;

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  num_server_side_tools_used?: number;
  cost_in_usd_ticks?: number | null;
  server_side_tool_usage_details?: Record<string, number>;
}

export interface FunctionCall { call_id: string; name: string; arguments: string; id?: string }
export interface Citation { url: string; title?: string }

export interface ResponsesRequest extends TransportOptions {
  model: string;
  input: string | InputItem[];
  previousResponseId?: string;
  tools?: ResponseTool[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  store?: boolean;
  include?: string[];
  /** text.format, e.g. {type:'json_schema', name, schema, strict:true} (structured outputs). */
  textFormat?: Record<string, unknown>;
  maxTurns?: number;
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Server-side tool activity (web_search_call, x_search_call, code_interpreter_call, …). */
  onServerTool?: (item: InputItem, state: 'running' | 'done') => void;
}

export interface ResponsesResult {
  id?: string;
  status?: string;
  content: string;
  /** Output items exactly as returned (reasoning with encrypted_content, messages, calls). Pass back verbatim. */
  output: InputItem[];
  functionCalls: FunctionCall[];
  citations: Citation[];
  usage?: ResponsesUsage;
  latencyMs: number;
}

const SERVER_TOOL_ITEM = /_call$/;

export function buildResponsesPayload(r: ResponsesRequest): Record<string, unknown> {
  const p: Record<string, unknown> = { model: r.model, input: r.input, stream: true };
  if (r.previousResponseId) { p.previous_response_id = r.previousResponseId; }
  if (r.tools?.length) { p.tools = r.tools; p.tool_choice = 'auto'; }
  if (r.temperature !== undefined) { p.temperature = r.temperature; }
  if (r.maxOutputTokens) { p.max_output_tokens = r.maxOutputTokens; }
  if (r.reasoningEffort) { p.reasoning = { effort: r.reasoningEffort }; }
  if (r.store !== undefined) { p.store = r.store; }
  if (r.include?.length) { p.include = r.include; }
  if (r.textFormat) { p.text = { format: r.textFormat }; }
  if (r.maxTurns) { p.max_turns = r.maxTurns; }
  return p;
}

/** Collect url_citation annotations from output_text parts plus any top-level `citations` URL list. De-duplicated by URL. */
export function extractCitations(output: InputItem[], extra?: unknown): Citation[] {
  const seen = new Map<string, Citation>();
  for (const it of output) {
    if (it?.type !== 'message' || !Array.isArray(it.content)) { continue; }
    for (const c of it.content) {
      for (const a of Array.isArray(c?.annotations) ? c.annotations : []) {
        if (a?.type === 'url_citation' && typeof a.url === 'string' && !seen.has(a.url)) { seen.set(a.url, { url: a.url, title: typeof a.title === 'string' ? a.title : undefined }); }
      }
    }
  }
  if (Array.isArray(extra)) {
    for (const u of extra) { const url = typeof u === 'string' ? u : u?.url; if (typeof url === 'string' && !seen.has(url)) { seen.set(url, { url }); } }
  }
  return [...seen.values()].filter(c => /^https?:\/\//i.test(c.url));
}

export function textOf(output: InputItem[]): string {
  return output.filter(i => i?.type === 'message' && Array.isArray(i.content))
    .flatMap(i => i.content).filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c: any) => c.text).join('');
}

/** Pure reducer for Responses stream events, so it is unit-testable without HTTP. */
export class ResponsesStreamState {
  id?: string; status?: string; content = ''; usage?: ResponsesUsage; final?: any; error?: string;
  items: InputItem[] = [];
  constructor(private readonly r: Pick<ResponsesRequest, 'onContent' | 'onReasoning' | 'onServerTool'> = {}) {}

  handle(e: any): void {
    switch (e?.type) {
      case 'response.created': case 'response.in_progress':
        if (e.response?.id) { this.id = e.response.id; }
        break;
      case 'response.output_text.delta':
        if (typeof e.delta === 'string') { this.content += e.delta; this.r.onContent?.(e.delta); }
        break;
      case 'response.reasoning_summary_text.delta': case 'response.reasoning_text.delta':
        if (typeof e.delta === 'string') { this.r.onReasoning?.(e.delta); }
        break;
      case 'response.output_item.added':
        if (e.item && SERVER_TOOL_ITEM.test(e.item.type) && e.item.type !== 'function_call') { this.r.onServerTool?.(e.item, 'running'); }
        break;
      case 'response.output_item.done':
        if (e.item) {
          if (typeof e.output_index === 'number') { this.items[e.output_index] = e.item; } else { this.items.push(e.item); }
          if (SERVER_TOOL_ITEM.test(e.item.type) && e.item.type !== 'function_call') { this.r.onServerTool?.(e.item, 'done'); }
        }
        break;
      case 'response.completed': case 'response.incomplete':
        this.final = e.response; this.status = e.response?.status ?? e.type.slice(9);
        if (e.response?.id) { this.id = e.response.id; }
        if (e.response?.usage) { this.usage = e.response.usage; }
        break;
      case 'response.failed':
        this.error = e.response?.error?.message ?? 'Response failed.';
        break;
      case 'error':
        this.error = e.message ?? e.error?.message ?? 'Stream error.';
        break;
    }
  }

  result(started: number): ResponsesResult {
    if (this.error) { throw classifyStreamError(this.error); }
    const output: InputItem[] = Array.isArray(this.final?.output) && this.final.output.length ? this.final.output : this.items.filter(Boolean);
    const functionCalls = output.filter(i => i?.type === 'function_call' && i.name)
      .map(i => ({ call_id: String(i.call_id ?? i.id ?? ''), name: String(i.name), arguments: typeof i.arguments === 'string' ? i.arguments : JSON.stringify(i.arguments ?? {}), id: i.id }));
    const content = this.content || textOf(output);
    return { id: this.id, status: this.status, content, output, functionCalls, citations: extractCitations(output, this.final?.citations), usage: this.usage, latencyMs: Date.now() - started };
  }
}

function classifyStreamError(msg: string): GrokApiError {
  const l = msg.toLowerCase();
  if (/previous_response_not_found|previous response/.test(l)) { return new GrokApiError(msg, 'generic', 404); }
  if (/context|maximum|too long/.test(l)) { return new GrokApiError(`xAI: request exceeds the model context window. ${msg}`, 'context_length'); }
  return new GrokApiError(`xAI: ${msg}`, 'generic');
}

export async function streamResponse(r: ResponsesRequest): Promise<ResponsesResult> {
  const started = Date.now();
  const st = new ResponsesStreamState(r);
  await postXai('/responses', buildResponsesPayload(r), r, (e) => st.handle(e));
  return st.result(started);
}

/** POST /v1/responses/compact: returns the compacted output (a single compaction item) to use as the head of the next input. */
export async function compactInput(t: TransportOptions & { model: string }, input: InputItem[]): Promise<{ output: InputItem[]; dropped?: number }> {
  // The endpoint has no `store` parameter (docs: advanced-api-usage/context-compaction); it returns an opaque blob.
  const res: any = await postXai('/responses/compact', { model: t.model, input }, t);
  if (!Array.isArray(res?.output) || !res.output.length) { throw new GrokApiError('Compaction returned no output.', 'generic'); }
  return { output: res.output, dropped: res.usage?.dropped_message_count };
}

/** True when an error means the server no longer has the previous response (so resend full local history). */
export function isPreviousResponseMissing(e: unknown): boolean {
  const err = e as GrokApiError;
  return (err?.statusCode === 404 || err?.statusCode === 400) && /previous|not found|not_found/i.test(err.message ?? '');
}
