// Pure Responses-API tool loop (no vscode import) so it can be unit-tested against a fake server.
// Function calling: https://docs.x.ai/developers/tools/function-calling
// Chaining with previous_response_id: https://docs.x.ai/developers/model-capabilities/text/generate-text#chaining-the-conversation
import { GrokApiError } from '../xai/client';
import { InputItem, ResponseTool, ResponsesResult, FunctionCall, isPreviousResponseMissing } from '../xai/responses';
import { parseArgs } from './loop';

/** Conversation state kept by the client: a verbatim local mirror of every input/output item plus the last response id. */
export interface ConversationState {
  items: InputItem[];
  previousResponseId?: string;
}

export interface ResponsesLoopOptions {
  state: ConversationState;
  /** New items for this turn (system message on a fresh chain, then the user message). */
  newInput: InputItem[];
  tools: ResponseTool[];
  maxSteps: number;
  /** Use previous_response_id (server-side history, store=true). When false, the full local item list is sent each call. */
  useChain: boolean;
  request: (input: InputItem[], previousResponseId: string | undefined, tools: ResponseTool[]) => Promise<ResponsesResult>;
  execute: (name: string, args: unknown, call: FunctionCall) => Promise<string>;
  isCancelled?: () => boolean;
  onToolStart?: (call: FunctionCall, args: unknown) => void;
  onToolEnd?: (call: FunctionCall, args: unknown, result: string) => void;
  onStepEnd?: (step: number, res: ResponsesResult) => void;
}

export interface ResponsesLoopResult {
  steps: number; toolCalls: number; hitStepCap: boolean; finalText: string;
  outputTokens: number; reasoningTokens: number; cachedTokens: number; lastInputTokens: number; costTicks: number;
  citations: { url: string; title?: string }[];
}

export async function runResponsesLoop(o: ResponsesLoopOptions): Promise<ResponsesLoopResult> {
  const s = o.state;
  s.items.push(...o.newInput);
  const acc: ResponsesLoopResult = { steps: 0, toolCalls: 0, hitStepCap: false, finalText: '', outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, lastInputTokens: 0, costTicks: 0, citations: [] };
  const seen = new Set<string>();

  const send = async (pending: InputItem[], tools: ResponseTool[]): Promise<ResponsesResult> => {
    let res: ResponsesResult;
    if (o.useChain && s.previousResponseId) {
      try { res = await o.request(pending, s.previousResponseId, tools); }
      catch (e) {
        if (!isPreviousResponseMissing(e)) { throw e; }
        res = await o.request(s.items, undefined, tools); // stored response expired (30 days) or missing: resend local history
      }
    } else {
      res = await o.request(s.items, undefined, tools);
    }
    s.items.push(...res.output);
    s.previousResponseId = o.useChain ? res.id : undefined;
    const u = res.usage;
    acc.outputTokens += u?.output_tokens ?? 0;
    acc.reasoningTokens += u?.output_tokens_details?.reasoning_tokens ?? 0;
    acc.cachedTokens += u?.input_tokens_details?.cached_tokens ?? 0;
    acc.costTicks += u?.cost_in_usd_ticks ?? 0;
    if (u?.input_tokens) { acc.lastInputTokens = u.input_tokens; }
    for (const c of res.citations) { if (!seen.has(c.url)) { seen.add(c.url); acc.citations.push(c); } }
    return res;
  };

  let pending = o.newInput;
  for (let step = 0; ; step++) {
    const res = await send(pending, o.tools);
    o.onStepEnd?.(step, res);
    const calls = res.functionCalls;
    if (!calls.length) { return { ...acc, steps: step + 1, finalText: res.content }; }
    const outputs: InputItem[] = [];
    for (const call of calls) {
      if (o.isCancelled?.()) { throw new GrokApiError('Request cancelled.', 'aborted'); }
      const args = parseArgs(call.arguments);
      o.onToolStart?.(call, args);
      let out: string;
      try { out = await o.execute(call.name, args, call); } catch (e) { out = `Error: ${(e as Error).message}`; }
      acc.toolCalls++;
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: out });
      o.onToolEnd?.(call, args, out);
    }
    s.items.push(...outputs);
    pending = outputs;
    if (step + 1 >= o.maxSteps) {
      const note = { role: 'user', content: `[Step limit of ${o.maxSteps} tool rounds reached. Do not call tools. Summarise what you found and what remains.]` };
      s.items.push(note);
      const fin = await send([...outputs, note], []);
      return { ...acc, steps: step + 2, hitStepCap: true, finalText: fin.content };
    }
  }
}
