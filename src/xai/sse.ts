// Pure SSE + delta parsing for the xAI (OpenAI-compatible) chat completions stream.
import { StringDecoder } from 'string_decoder';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface StreamDelta {
  content?: string;
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[];
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Incremental SSE line parser. UTF-8 safe across chunk boundaries. */
export class SseParser {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  public done = false;

  constructor(private readonly onEvent: (data: unknown) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.drain(false);
  }

  end(): void {
    this.buffer += this.decoder.end();
    this.drain(true);
  }

  private drain(final: boolean): void {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = final ? '' : lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) { continue; }
      const data = line.slice(5).trim();
      if (data === '[DONE]') { this.done = true; continue; }
      try { this.onEvent(JSON.parse(data)); } catch { /* ignore malformed */ }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseDelta(evt: any): StreamDelta {
  const choice = evt?.choices?.[0];
  const d = choice?.delta ?? {};
  const out: StreamDelta = {};
  if (typeof d.content === 'string' && d.content) { out.content = d.content; }
  if (Array.isArray(d.tool_calls)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.toolCalls = d.tool_calls.map((t: any, i: number) => ({
      index: typeof t.index === 'number' ? t.index : i,
      id: t.id,
      name: t.function?.name,
      arguments: t.function?.arguments,
    }));
  }
  if (choice?.finish_reason) { out.finishReason = choice.finish_reason; }
  if (evt?.usage) { out.usage = evt.usage; }
  return out;
}

/** Accumulates streamed tool_call fragments into complete calls. */
export class ToolCallAccumulator {
  private calls: ToolCall[] = [];
  add(parts: NonNullable<StreamDelta['toolCalls']>): void {
    for (const p of parts) {
      let c = this.calls[p.index];
      if (!c) { c = this.calls[p.index] = { id: '', type: 'function', function: { name: '', arguments: '' } }; }
      if (p.id) { c.id = p.id; }
      if (p.name) { c.function.name += p.name; }
      if (p.arguments) { c.function.arguments += p.arguments; }
    }
  }
  result(): ToolCall[] {
    return this.calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  }
}

/** Strip a single surrounding markdown fence from model output. */
export function stripFences(text: string): string {
  const m = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : text;
}
