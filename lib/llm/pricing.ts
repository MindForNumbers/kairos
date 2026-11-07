/**
 * USD per million tokens, Anthropic first-party API list prices (as of 2026-10-06; re-check
 * https://www.anthropic.com/pricing when changing models). Unknown models are refused, not
 * guessed: spend caps can't be enforced on a model we can't price.
 */
type Rate = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelPricing = { base: Rate; longPrompt?: { overTokens: number; rate: Rate } };

const rate = (input: number, output: number, cacheRead = input * 0.1): Rate => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

const PRICES: Record<string, ModelPricing> = {
  "claude-haiku-5-5": { base: rate(0.10, 0.50), longPrompt: { overTokens: 100_000, rate: rate(0.50, 2.50) } },
  "claude-sonnet-5-5": { base: rate(2, 10, 0.20) },
  "claude-sonnet-5": { base: rate(2, 10) },
  "claude-opus-5-5": { base: rate(4, 20, 0.20) },
  "claude-opus-5": { base: rate(5, 25) },
  "claude-haiku-4-5": { base: rate(1, 5) },
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

function pricingFor(model: string): ModelPricing {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model "${model}"; add it to lib/llm/pricing.ts before using it (spend caps depend on it)`);
  return p;
}

export function assertPriced(model: string): void {
  pricingFor(model);
}

/** Actual cost of a completed call. Output includes thinking tokens, which are billed as output. */
export function costOf(model: string, u: Usage): number {
  const p = pricingFor(model);
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const r = p.longPrompt && prompt > p.longPrompt.overTokens ? p.longPrompt.rate : p.base;
  return (u.inputTokens * r.input + u.outputTokens * r.output + u.cacheReadTokens * r.cacheRead + u.cacheWriteTokens * r.cacheWrite) / 1_000_000;
}

/**
 * Upper bound for a call before it runs: prompt tokens over-estimated at 1 token per
 * 2.5 characters, and output at the full max_tokens.
 */
export function maxCostOf(model: string, promptChars: number, maxTokens: number): number {
  const inputTokens = Math.ceil(promptChars / 2.5);
  return costOf(model, { inputTokens, outputTokens: maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
}
