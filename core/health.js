import { CONFIG } from './config.js';
import { STATUS, TRANSIENT_STATUS, ROTATION_BLOCKING_KEY_STATUS } from './statuses.js';
import { clamp, nowMs } from './util.js';

/**
 * Health, score, cooldown and circuit breaker (§16, §17, §18, §19).
 * Deterministic — no ML, no randomness (§16).
 */

const scoreCfg = CONFIG.score;
const cdCfg = CONFIG.cooldown;
const circuitCfg = CONFIG.circuit;

/**
 * Smart score (§16): deterministic, uses health/latency/failures/cooldown/
 * recency. Higher is better.
 */
export function computeScore(mapping, { now = nowMs() } = {}) {
  if (!mapping) return 0;

  let score = scoreCfg.base;

  if (mapping.status === STATUS.HEALTHY) score += scoreCfg.healthyBonus;
  else if (mapping.status === STATUS.DISCOVERED) score += scoreCfg.discoveredBonus;

  if (mapping.cooldownUntil) {
    const remaining = mapping.cooldownUntil - now;
    if (remaining > 0) score -= scoreCfg.cooldownPenalty;
  }

  if (Number.isFinite(mapping.latencyMs)) {
    score -= clamp(mapping.latencyMs * scoreCfg.latencyPenaltyPerMs, 0, scoreCfg.latencyPenaltyMax);
  }

  score -= clamp((mapping.failureCount ?? 0) * scoreCfg.failurePenaltyPerCount, 0, scoreCfg.failurePenaltyMax);

  if (mapping.lastSuccessAt) {
    const age = now - Date.parse(mapping.lastSuccessAt);
    if (Number.isFinite(age) && age > scoreCfg.staleAfterMs) score -= scoreCfg.stalePenalty;
  }

  return Math.round(score);
}

/** Cooldown window for a failure (§17). Retry-After wins when present. */
export function computeCooldownMs(status, { retryAfterMs = null, failureCount = 0, now = nowMs() } = {}) {
  if (status === STATUS.RATE_LIMITED) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, cdCfg.retryAfterCapMs);
    }
    const backoff = cdCfg.rateLimitBaseMs * 2 ** Math.min(failureCount, 10);
    return Math.min(backoff, cdCfg.rateLimitMaxMs);
  }
  if (status === STATUS.TEMP_ERROR) {
    const backoff = cdCfg.tempErrorBaseMs * 2 ** Math.min(failureCount, 10);
    return Math.min(backoff, cdCfg.tempErrorMaxMs);
  }
  return 0;
}

/** Apply a failure result to a mapping: status, cooldown, failure count, score. */
export function applyFailure(mapping, classification, { now = nowMs() } = {}) {
  const failureCount = (mapping.failureCount ?? 0) + 1;
  const cooldownMs = computeCooldownMs(classification.status, {
    retryAfterMs: classification.retryAfterMs,
    failureCount,
    now,
  });

  const next = {
    ...mapping,
    status: classification.status,
    verified: mapping.verified && classification.status !== STATUS.AUTH_INVALID,
    failureCount,
    lastFailureAt: new Date(now).toISOString(),
    lastTestAt: new Date(now).toISOString(),
    lastErrorClass: classification.status,
    lastErrorMessage: classification.message ?? null,
    cooldownUntil: cooldownMs > 0 ? now + cooldownMs : null,
  };

  next.score = computeScore(next, { now });
  return next;
}

/** Apply a success result to a mapping: reset failures, clear cooldown. */
export function applySuccess(mapping, { latencyMs = null, now = nowMs() } = {}) {
  const next = {
    ...mapping,
    status: STATUS.HEALTHY,
    verified: true,
    failureCount: 0,
    cooldownUntil: null,
    latencyMs: latencyMs ?? mapping.latencyMs,
    lastSuccessAt: new Date(now).toISOString(),
    lastTestAt: new Date(now).toISOString(),
    lastErrorClass: null,
    lastErrorMessage: null,
  };
  next.score = computeScore(next, { now });
  return next;
}

/**
 * Is a mapping currently eligible for rotation (§15)?
 * Skips: key-level blocks, active cooldown, disabled, model-denied
 * (for THIS mapping only).
 */
export function isEligible(mapping, key, { now = nowMs() } = {}) {
  if (!mapping || !key) return false;
  if (key.enabled === false) return false;
  if (ROTATION_BLOCKING_KEY_STATUS.has(mapping.status)) return false;
  if (ROTATION_BLOCKING_KEY_STATUS.has(key.status)) return false;
  if (mapping.status === STATUS.MODEL_DENIED) return false;
  if (mapping.status === STATUS.DISABLED) return false;
  if (mapping.cooldownUntil && mapping.cooldownUntil > now) return false;
  return true;
}

// ------------------------------------------------------------ Circuit breaker

/**
 * Circuit breaker per provider (§18).
 * States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED/OPEN.
 * Pure function of breaker state + outcome, persisted by the caller.
 */
export const CIRCUIT_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

export function initialBreaker() {
  return {
    state: CIRCUIT_STATE.CLOSED,
    failures: 0,
    windowStart: null,
    openedAt: null,
    halfOpenProbes: 0,
  };
}

export function isProviderAvailable(breaker, { now = nowMs() } = {}) {
  if (!breaker) return true;
  if (breaker.state === CIRCUIT_STATE.OPEN) {
    if (breaker.openedAt && now - breaker.openedAt >= circuitCfg.openMs) return true; // HALF_OPEN eligible
    return false;
  }
  return true;
}

export function recordProviderFailure(breaker, { now = nowMs() } = {}) {
  const state = breaker ?? initialBreaker();
  const withinWindow =
    state.windowStart !== null && now - state.windowStart <= circuitCfg.windowMs;

  const failures = withinWindow ? state.failures + 1 : 1;
  const windowStart = withinWindow ? state.windowStart : now;

  if (failures >= circuitCfg.failureThreshold) {
    return {
      state: CIRCUIT_STATE.OPEN,
      failures,
      windowStart,
      openedAt: now,
      halfOpenProbes: 0,
    };
  }

  return { ...state, failures, windowStart };
}

export function recordProviderSuccess(breaker) {
  return initialBreaker();
}

/** Transition an OPEN breaker whose cooldown elapsed into HALF_OPEN. */
export function refreshBreaker(breaker, { now = nowMs() } = {}) {
  if (breaker?.state === CIRCUIT_STATE.OPEN && breaker.openedAt && now - breaker.openedAt >= circuitCfg.openMs) {
    return { ...breaker, state: CIRCUIT_STATE.HALF_OPEN, halfOpenProbes: 0 };
  }
  return breaker ?? initialBreaker();
}

/**
 * Auto-recovery eligibility (§19).
 * Transient statuses self-heal; terminal statuses need a manual recheck.
 */
export function isRecoverable(status) {
  return TRANSIENT_STATUS.has(status);
}

export function needsManualRecheck(status) {
  return !TRANSIENT_STATUS.has(status) && ![STATUS.HEALTHY, STATUS.DISCOVERED, STATUS.UNRESOLVED].includes(status);
}

/** Recompute and persist score for every mapping. */
export async function rescoreAll(registry, { now = nowMs() } = {}) {
  const mappings = await registry.listMappings();
  let updated = 0;
  for (const mapping of mappings) {
    const score = computeScore(mapping, { now });
    if (score !== mapping.score) {
      await registry.updateMapping(mapping.id, { score });
      updated += 1;
    }
  }
  return { total: mappings.length, updated };
}
