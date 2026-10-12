// Demo budget (pure; no vscode import).

/** grok-4.7 list prices per 1M tokens (docs.x.ai, Oct 2026): $2 input, $0.50 cached input, $6 output. */
export const CACHED_WEIGHT = 0.25;
export const OUTPUT_WEIGHT = 3;
/**
 * Demo spend cap (Timothy: under $1). Reported cost is used whenever xAI reports it. Otherwise the cap is in
 * "input-equivalent" tokens: uncached input + 0.25 × cached + 3 × output. 450k of those is about $0.90 at list price
 * ($0.99 on the 1.1× US endpoint). A full demo (~15 tool calls, context chained and cached) is estimated at
 * ~250–300k, about $0.50–0.60.
 */
export const DEMO_LIMITS = { maxCostUsd: 1, maxWeightedTokens: 450_000 };
/** Each "Continue" on the budget card adds this much. */
export const DEMO_STEP = { costUsd: 0.5, weightedTokens: 225_000 };
export const DEMO_STOP_PREFIX = 'demo budget';

export function isDemoTrigger(text: string): boolean {
  return /\b(?:execute|run|start|do|continue)\s+(?:with\s+)?(?:the\s+)?demo\b|\bbuild\s+(?:the\s+)?(?:example|sample)\s+project\b/i.test(text);
}

export interface DemoSpend { input: number; cached: number; output: number; costUsd: number; costMissing: boolean }
export function weightedTokens(s: Pick<DemoSpend, 'input' | 'cached' | 'output'>): number {
  const cached = Math.min(Math.max(0, s.cached), Math.max(0, s.input));
  return Math.round((s.input - cached) + CACHED_WEIGHT * cached + OUTPUT_WEIGHT * s.output);
}
/** Reason string when the demo is over budget, else undefined. Reported cost wins; tokens only when cost is missing. */
export function demoOverBudget(s: DemoSpend, limits: { maxCostUsd: number; maxWeightedTokens: number }): string | undefined {
  if (!s.costMissing) {
    return s.costUsd >= limits.maxCostUsd ? `${DEMO_STOP_PREFIX} of $${limits.maxCostUsd.toFixed(2)} reached ($${s.costUsd.toFixed(2)} as reported by xAI)` : undefined;
  }
  const w = weightedTokens(s);
  return w >= limits.maxWeightedTokens ? `${DEMO_STOP_PREFIX} reached (~${Math.round(w / 1000)}k input-equivalent tokens; xAI reported no cost)` : undefined;
}
export function addSpend(a: DemoSpend, b: DemoSpend): DemoSpend {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, costUsd: a.costUsd + b.costUsd, costMissing: a.costMissing || b.costMissing };
}
export const ZERO_SPEND: DemoSpend = { input: 0, cached: 0, output: 0, costUsd: 0, costMissing: false };
