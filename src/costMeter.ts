// Per-chat running usage. Costs come only from the API's usage.cost_in_usd_ticks (1 tick = 1e-10 USD); nothing is estimated.
export interface TurnUsage { input: number; inputUnknown?: boolean; output: number; reasoning: number; cached: number; costUsd?: number; costMissing?: number }
export interface MeterState { turns: number; input: number; output: number; reasoning: number; cached: number; costUsd: number; costTurns: number; missing: number; inputUnknown: number }

export const emptyMeter = (): MeterState => ({ turns: 0, input: 0, output: 0, reasoning: 0, cached: 0, costUsd: 0, costTurns: 0, missing: 0, inputUnknown: 0 });

export function addTurn(m: MeterState, u: TurnUsage): MeterState {
  const has = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd);
  return {
    turns: m.turns + 1, input: m.input + (u.input | 0), output: m.output + (u.output | 0), reasoning: m.reasoning + (u.reasoning | 0), cached: m.cached + (u.cached | 0),
    costUsd: m.costUsd + (has ? u.costUsd! : 0), costTurns: m.costTurns + (has ? 1 : 0), missing: m.missing + (!has || (u.costMissing ?? 0) > 0 ? 1 : 0), inputUnknown: m.inputUnknown + (u.inputUnknown ? 1 : 0),
  };
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n);
}
export function fmtUsd(v: number): string { return v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2); }

/** Header text, accessible name and breakdown lines. Cost is shown only if the API reported it. */
export function meterView(m: MeterState): { hidden: boolean; text: string; ariaLabel: string; tooltip: string; lines: string[] } {
  if (!m.turns) { return { hidden: true, text: '', ariaLabel: '', tooltip: '', lines: [] }; }
  const tok = fmtTokens(m.input + m.output) + ' tok';
  const cost = m.costTurns ? fmtUsd(m.costUsd) + (m.missing ? '+' : '') : '';
  const lines = [
    `This chat: ${m.turns} turn${m.turns === 1 ? '' : 's'}`,
    m.inputUnknown >= m.turns ? 'Input: not reported (Chat Completions)' : `Input: ${m.input.toLocaleString('en-US')} tokens (${m.cached.toLocaleString('en-US')} cached)${m.inputUnknown ? ` — not reported for ${m.inputUnknown} turn${m.inputUnknown === 1 ? '' : 's'}` : ''}`,
    `Output: ${m.output.toLocaleString('en-US')} tokens (${m.reasoning.toLocaleString('en-US')} reasoning)`,
    m.costTurns ? `Cost reported by xAI: ${fmtUsd(m.costUsd)}` : 'Cost: not reported by the API for this chat (tokens only)',
    ...(m.costTurns && m.missing ? [`+ = some turns didn't report a cost (${m.missing} of ${m.turns}); they aren't included`] : []),
    'Resets on New chat.',
  ];
  const ariaLabel = `Chat usage: ${m.input + m.output} tokens` + (m.costTurns ? `, ${m.missing ? 'at least ' : ''}${fmtUsd(m.costUsd)}` : '') + '. Show details';
  return { hidden: false, text: tok + (cost ? ' · ' + cost : ''), ariaLabel, tooltip: lines.join('\n'), lines };
}
