/**
 * @fx/llm — Step 3.1 LLM plumbing.
 *
 * BE-060: provider factory + automatic failover (factory.ts, providers.ts,
 * catalog.ts). BE-061: prompt registry + model snapshot pinning
 * (registry.ts). Consumed by the agent graph (BE-062, Step 3.2) and the
 * signals worker (BE-066).
 */
export {
  CAPABILITY_TIERS,
  type CapabilityTier,
  costUsd,
  DEFAULT_CATALOG,
  downgradeTier,
  FAILOVER_ORDER,
  type ModelCatalog,
  type PinnedModel,
  PROVIDERS,
  type ProviderName,
} from './catalog.js';
export { type LlmErrorKind, LlmExhaustedError, LlmProviderError } from './errors.js';
export {
  type Clock,
  type DowngradeReason,
  type InvokeParams,
  type InvokeResult,
  type LedgerSink,
  LlmClient,
  type LlmClientOptions,
  type LlmRunRecord,
  type SpendProvider,
} from './factory.js';
export {
  AnthropicAdapter,
  type ChatParams,
  type ChatResult,
  type FetchLike,
  GeminiAdapter,
  OpenAiAdapter,
  OpenRouterAdapter,
  type ProviderAdapter,
} from './providers.js';
export {
  type DecisionProvenance,
  type PromptDefinition,
  promptHash,
  PromptRegistry,
  type RegisteredPrompt,
  requiresRevalidation,
} from './registry.js';
