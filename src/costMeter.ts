// Per-chat running usage. Costs come only from the API's usage.cost_in_usd_ticks (1 tick = 1e-10 USD); nothing is estimated.
export interface TurnUsage { input: number; output: number; reasoning: number; cached: number; costUsd?: number; costMissing?: number }
export interface MeterState { turns: number; input: number; output: number; reasoning: number; cached: number; costUsd: number; costTurns: number; missing: number }

export const emptyMeter = (): MeterState => ({ turns: 0, input: 0, output: 0, reasoning: 0, cached: 0, costUsd: 0, costTurns: 0, missing: 0 });

export function addTurn(m: MeterState, u: TurnUsage): MeterState {
  const has = typeof u.costUsd === 'number' && Number.isFinite(u.costUsd);
  return {
    turns: m.turns + 1, input: m.input + (u.input | 0), output: m.output + (u.output | 0), reasoning: m.reasoning + (u.reasoning | 0), cached: m.cached + (u.cached | 0),
    costUsd: m.costUsd + (has ? u.costUsd! : 0), costTurns: m.costTurns + (has ? 1 : 0), missing: m.missing + (!has || (u.costMissing ?? 0) > 0 ? 1 : 0),
  };
}

export function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n);
}
export function fmtUsd(v: number): string { return v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2); }

/** Header text + tooltip. Cost is shown only if the API reported it; "+" marks turns without a reported cost. */
export function meterView(m: MeterState): { hidden: boolean; text: string; tooltip: string } {
  if (!m.turns) { return { hidden: true, text: '', tooltip: '' }; }
  const tok = m.input + m.output;
  const cost = m.costTurns ? fmtUsd(m.costUsd) + (m.missing ? '+' : '') : '';
  const lines = [
    `This chat: ${m.turns} turn${m.turns === 1 ? '' : 's'}`,
    `Input: ${m.input.toLocaleString('en-US')} tokens (${m.cached.toLocaleString('en-US')} cached)`,
    `Output: ${m.output.toLocaleString('en-US')} tokens (${m.reasoning.toLocaleString('en-US')} reasoning)`,
    m.costTurns ? `Cost reported by xAI: ${fmtUsd(m.costUsd)}${m.missing ? ` (${m.missing} turn${m.missing === 1 ? '' : 's'} without a reported cost not included)` : ''}` : 'Cost: not reported by the API for this chat (tokens only)',
    'Resets on New chat.',
  ];
  return { hidden: false, text: fmtTokens(tok) + ' tok' + (cost ? ' · ' + cost : ''), tooltip: lines.join('\n') };
}
