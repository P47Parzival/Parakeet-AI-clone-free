/**
 * Per-provider rates used to turn raw usage into dollars.
 *
 * Vendors do not expose "credits left" on a normal API key (Deepgram is the one
 * exception, and only for keys with the billing:read scope), so Parak meters what it
 * actually spends and shows that against a budget you set.
 */

/** USD per million tokens. */
export interface TokenRate {
  input: number;
  output: number;
}

/** Anthropic list prices, June 2026. Cache writes bill at 1.25x input, cache reads at 0.1x. */
export const ANTHROPIC_RATES: Record<string, TokenRate> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** OpenAI list prices. Endpoints we can't price (Groq/Gemini free tiers, Ollama) fall through to zero. */
export const OPENAI_RATES: Record<string, TokenRate> = {
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function rateFor(provider: "anthropic" | "openai", model: string): TokenRate | null {
  const table = provider === "anthropic" ? ANTHROPIC_RATES : OPENAI_RATES;
  if (table[model]) return table[model];
  // Model ids sometimes carry a date or vendor prefix; match on the longest known key.
  const hit = Object.keys(table)
    .filter((k) => model.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? table[hit] : null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Dollars for one request. Returns 0 for endpoints with no published price (free tiers, local models). */
export function tokenCost(provider: "anthropic" | "openai", model: string, u: TokenUsage): number {
  const r = rateFor(provider, model);
  if (!r) return 0;
  const billableInput =
    u.input + u.cacheWrite * CACHE_WRITE_MULTIPLIER + u.cacheRead * CACHE_READ_MULTIPLIER;
  return (billableInput * r.input + u.output * r.output) / 1_000_000;
}

/** USD per minute of audio. Deepgram Nova-3 and OpenAI transcription pay-as-you-go rates. */
export const STT_RATE_PER_MIN: Record<string, number> = {
  deepgram: 0.0077,
  openai: 0.006,
  webspeech: 0,
};

export function sttCost(provider: string, seconds: number): number {
  return ((STT_RATE_PER_MIN[provider] ?? 0) * seconds) / 60;
}
