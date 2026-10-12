/** Demo spend cap (Timothy: under $1). Where xAI doesn't report cost, the conservative token cap applies instead. */
export const DEMO_LIMITS = { maxCostUsd: 1, maxTokens: 400_000 };
export function isDemoTrigger(text: string): boolean {
  return /\b(?:execute|run|start|do)\s+(?:the\s+)?demo\b|\bbuild\s+(?:the\s+)?(?:example|sample)\s+project\b/i.test(text);
}
