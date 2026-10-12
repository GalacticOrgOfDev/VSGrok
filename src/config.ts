import * as vscode from 'vscode';
import { RequestOptions } from './xai/client';

export const SECRET_KEY = 'vsgrok.apiKey';
export const DEFAULT_MODEL = 'grok-4.7';

export function cfg() { return vscode.workspace.getConfiguration('vsgrok'); }

export function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

export async function requestOptions(ctx: vscode.ExtensionContext, over: Partial<RequestOptions> = {}): Promise<RequestOptions> {
  const c = cfg();
  return {
    apiKey: (await ctx.secrets.get(SECRET_KEY)) ?? '',
    baseUrl: c.get<string>('baseUrl') || 'https://api.x.ai/v1',
    model: c.get<string>('model') || DEFAULT_MODEL,
    temperature: clampNum(c.get('temperature'), 0, 2, 0.3),
    maxTokens: clampNum(c.get('maxTokens'), 1, 131072, 8192),
    reasoningEffort: (['low', 'medium', 'high', 'xhigh'] as const).find(v => v === c.get<string>('reasoningEffort')),
    timeoutMs: clampNum(c.get('requestTimeoutSeconds'), 5, 600, 120) * 1000,
    ...over,
  };
}

export type ApiMode = 'responses' | 'chat';
export function apiMode(): ApiMode { return cfg().get<string>('api') === 'chat' ? 'chat' : 'responses'; }

/** Built-in server-side tools enabled in settings (docs.x.ai/developers/tools/overview). */
export function serverTools(): import('./xai/responses').ServerTool[] {
  const c = cfg();
  const out: import('./xai/responses').ServerTool[] = [];
  if (c.get<boolean>('tools.webSearch')) { out.push({ type: 'web_search' }); }
  if (c.get<boolean>('tools.xSearch')) { out.push({ type: 'x_search' }); }
  if (c.get<boolean>('tools.codeExecution')) { out.push({ type: 'code_interpreter' }); }
  return out;
}
