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

/**
 * Pre-flight estimate. Token counts were measured from the full scripted demo in the mock integration test
 * ("demo e2e"): request sizes at ~4 chars/token, chained with prompt caching, plus allowances the mock can't see
 * (low-effort reasoning per call, search results pulled into context). Prices: grok-4.7 list (docs.x.ai/developers/pricing).
 */
export const DEMO_PRICES = { input: 2, cached: 0.5, output: 6, webSearchCall: 0.005, xPost: 0.005 };
/*
 * Measured in the mock e2e run of the commit-buddy demo (10 calls): ~74.7k billed input tokens of which ~64.7k cacheable,
 * ~3.2k output. Conservative allowances on top (the mock can't see these):
 *   - low-effort reasoning: 1.5k output tokens per call -> +15k output
 *   - web + X search results: 20k uncached input each -> +40k, carried as context into the 6 later calls -> +120k cacheable
 *   - half of the cacheable tokens miss the cache -> moved to uncached
 * => uncached ≈ 10k + 40k + (64.7k + 120k) / 2 ≈ 142k, cached ≈ 92k, output ≈ 18k -> about $0.44 in tokens + $0.055 search fees.
 */
export const DEMO_EST_TOKENS = { input: 142_000, cached: 92_000, output: 18_000, calls: 10 };
export function demoEstimateUsd(t: { input: number; cached: number; output: number } = DEMO_EST_TOKENS): number {
  const p = DEMO_PRICES;
  const tokens = (t.input * p.input + t.cached * p.cached + t.output * p.output) / 1e6;
  return tokens + p.webSearchCall + 10 * p.xPost;
}
