/**
 * BE-060/061 — model catalog: capability tiers → pinned model snapshots.
 *
 * Downgrade logic NEVER touches model names — it moves one capability tier
 * and the catalog resolves the pinned snapshot for (provider, tier). Exact
 * snapshot IDs are pinned here (BE-061); changing one changes what
 * `requiresRevalidation` sees and flags re-validation.
 *
 * ⚠️ Prices are USD per 1M tokens, checked 2026-07-09 against provider
 * pricing pages — REVIEW before first live month; they drive the cost-cap
 * downgrade (§9.4). Sonnet 5 is intro-priced $2/$10 until 2026-08-31, then
 * $3/$15.
 */

export const PROVIDERS = ['anthropic', 'openrouter', 'openai', 'gemini'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/**
 * Static failover order (§9.4): Anthropic → OpenRouter (same model family) →
 * OpenAI → Gemini. A call's chain starts at its (possibly overridden)
 * primary and continues in this order.
 */
export const FAILOVER_ORDER: readonly ProviderName[] = [
  'anthropic',
  'openrouter',
  'openai',
  'gemini',
];

export const CAPABILITY_TIERS = ['premium', 'standard', 'economy'] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export interface PinnedModel {
  /** Exact snapshot ID sent to the provider API. */
  model: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export type ModelCatalog = Record<ProviderName, Record<CapabilityTier, PinnedModel>>;

export const DEFAULT_CATALOG: ModelCatalog = {
  anthropic: {
    premium: { model: 'claude-opus-4-8', inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    standard: { model: 'claude-sonnet-5', inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    economy: { model: 'claude-haiku-4-5-20251001', inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  },
  // OpenRouter routes the SAME family as the primary (Anthropic) — failover
  // does not change model family, only transport (§9.4).
  openrouter: {
    premium: { model: 'anthropic/claude-opus-4.8', inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
    standard: { model: 'anthropic/claude-sonnet-5', inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    economy: { model: 'anthropic/claude-haiku-4.5', inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  },
  openai: {
    premium: { model: 'gpt-5.6-sol', inputUsdPerMTok: 5, outputUsdPerMTok: 30 },
    standard: { model: 'gpt-5.6-terra', inputUsdPerMTok: 2.5, outputUsdPerMTok: 15 },
    economy: { model: 'gpt-5.6-luna', inputUsdPerMTok: 1, outputUsdPerMTok: 6 },
  },
  gemini: {
    premium: { model: 'gemini-3.1-pro', inputUsdPerMTok: 2, outputUsdPerMTok: 12 },
    standard: { model: 'gemini-3.5-flash', inputUsdPerMTok: 1.5, outputUsdPerMTok: 9 },
    economy: { model: 'gemini-3.1-flash-lite', inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.5 },
  },
};

/** One tier down; economy is the floor. */
export function downgradeTier(tier: CapabilityTier): CapabilityTier {
  if (tier === 'premium') return 'standard';
  return 'economy';
}

export function costUsd(pin: PinnedModel, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * pin.inputUsdPerMTok + outputTokens * pin.outputUsdPerMTok) / 1_000_000
  );
}
