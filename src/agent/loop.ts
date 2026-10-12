// Pure tool-calling loop (no vscode import) so it can be unit-tested against a fake server.
import { ChatMessage, StreamResult, ToolSpec, GrokApiError } from '../xai/client';
import { ToolCall } from '../xai/sse';

export interface ToolLoopOptions {
  /** System message + prior history; assistant/tool messages are appended to `history` in place. */
  system: ChatMessage;
  history: ChatMessage[];
  tools: ToolSpec[];
  maxSteps: number;
  request: (messages: ChatMessage[], tools: ToolSpec[]) => Promise<StreamResult>;
  execute: (name: string, args: unknown, call: ToolCall) => Promise<string>;
  isCancelled?: () => boolean;
  onToolStart?: (call: ToolCall, args: unknown) => void;
  onToolEnd?: (call: ToolCall, args: unknown, result: string) => void;
  onStepEnd?: (step: number, res: StreamResult) => void;
}

export interface ToolLoopResult { steps: number; toolCalls: number; completionTokens: number; hitStepCap: boolean; finalText: string }

export function parseArgs(raw: string): unknown {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * Request → if tool_calls: run each, append role:'tool' results, request again → … until the model
 * answers without tool calls or maxSteps is reached.
 */
export async function runToolLoop(o: ToolLoopOptions): Promise<ToolLoopResult> {
  let toolCalls = 0; let completionTokens = 0;
  for (let step = 0; ; step++) {
    const res = await o.request([o.system, ...o.history], o.tools);
    completionTokens += res.usage?.completion_tokens ?? 0;
    const calls = o.tools.length ? res.toolCalls.filter(c => c.function.name) : [];
    o.history.push({ role: 'assistant', content: res.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    o.onStepEnd?.(step, res);
    if (!calls.length) { return { steps: step + 1, toolCalls, completionTokens, hitStepCap: false, finalText: res.content }; }
    for (const call of calls) {
      if (o.isCancelled?.()) { throw new GrokApiError('Request cancelled.', 'aborted'); }
      const args = parseArgs(call.function.arguments);
      o.onToolStart?.(call, args);
      let out: string;
      try { out = await o.execute(call.function.name, args, call); } catch (e) { out = `Error: ${(e as Error).message}`; }
      toolCalls++;
      o.history.push({ role: 'tool', tool_call_id: call.id, content: out });
      o.onToolEnd?.(call, args, out);
    }
    if (step + 1 >= o.maxSteps) {
      // Step cap: one last request without tools so the model must summarise instead of stopping mid-task.
      o.history.push({ role: 'user', content: `[Step limit of ${o.maxSteps} tool rounds reached. Do not call tools. Summarise what you found and what remains.]` });
      const fin = await o.request([o.system, ...o.history], []);
      completionTokens += fin.usage?.completion_tokens ?? 0;
      o.history.push({ role: 'assistant', content: fin.content || null });
      return { steps: step + 2, toolCalls, completionTokens, hitStepCap: true, finalText: fin.content };
    }
  }
}
