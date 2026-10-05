/**
 * Central configuration. No magic numbers scattered across modules.
 * All thresholds/tunables live here so tuning is a single-file change.
 */

export const CONFIG = {
  // ---- Probe / network ----
  probeTimeoutMs: 15000,
  discoveryTimeoutMs: 10000,
  testConcurrency: 4,
  testDelayMs: 120,

  // ---- Scoring weights (§16) ----
  score: {
    base: 50,
    healthyBonus: 30,
    discoveredBonus: 8,
    disabledPenalty: 1000,
    cooldownPenalty: 40,
    latencyPenaltyPerMs: 0.02,
    latencyPenaltyMax: 20,
    failurePenaltyPerCount: 12,
    failurePenaltyMax: 40,
    staleAfterMs: 30 * 60 * 1000,
    stalePenalty: 15,
    recentUsageBonus: 5,
  },

  // ---- Auto-map evidence weights (§24) ----
  // probe(inference) > discovery > heuristic. Keep this ordering.
  evidence: {
    inferencePass: 100,
    modelsPass: 70,
    modelFoundInProvider: 60,
    knownProviderConfig: 50,
    keyPrefixHint: 20,
    nameSimilarity: 10,
  },
  autoResolveMinEvidence: 60,
  autoResolveTieTolerance: 5,

  // ---- Circuit breaker (§18) ----
  circuit: {
    failureThreshold: 5,
    windowMs: 60 * 1000,
    openMs: 120 * 1000,
    halfOpenProbes: 1,
  },

  // ---- Cooldown / backoff (§17) ----
  cooldown: {
    rateLimitBaseMs: 30 * 1000,
    rateLimitMaxMs: 15 * 60 * 1000,
    tempErrorBaseMs: 5 * 1000,
    tempErrorMaxMs: 60 * 1000,
    retryAfterCapMs: 60 * 60 * 1000,
    tempErrorRetries: 2,
  },

  // ---- Recheck policy for terminal states (§19) ----
  // These are NOT spammed automatically; manual action or this interval.
  recheck: {
    manualOnly: true,
    intervalMs: 6 * 60 * 60 * 1000,
  },

  // ---- Event log retention (§31) ----
  eventLogLimit: 500,
  testHistoryLimit: 50,

  // ---- Storage (§27) ----
  storage: {
    driver: 'indexeddb',
    namespace: 'smart-api-registry',
  },

  // ---- Probe payload (§11) ----
  probe: {
    message: 'Reply exactly: OK',
    maxTokens: 5,
  },

  // ---- Key masking (§4) ----
  mask: {
    head: 4,
    tail: 4,
  },
};

export const CONFIG_PATH = 'core/config.js';
