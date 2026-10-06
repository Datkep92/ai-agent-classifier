/**
 * Mapping status enum (§12). UI adds emoji; core keeps plain values.
 */
export const STATUS = {
  HEALTHY: 'HEALTHY',
  DISCOVERED: 'DISCOVERED',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  AUTH_INVALID: 'AUTH_INVALID',
  EXPIRED: 'EXPIRED',
  MODEL_DENIED: 'MODEL_DENIED',
  PROVIDER_DOWN: 'PROVIDER_DOWN',
  TEMP_ERROR: 'TEMP_ERROR',
  REQUEST_ERROR: 'REQUEST_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  UNRESOLVED: 'UNRESOLVED',
  DISABLED: 'DISABLED',
};

export const STATUS_META = {
  HEALTHY: { emoji: '🟢', label: 'Healthy', scope: 'mapping' },
  DISCOVERED: { emoji: '🔵', label: 'Discovered', scope: 'mapping' },
  RATE_LIMITED: { emoji: '🟠', label: 'Cooldown', scope: 'mapping' },
  QUOTA_EXHAUSTED: { emoji: '🟣', label: 'Quota', scope: 'key' },
  AUTH_INVALID: { emoji: '🔴', label: 'Invalid', scope: 'key' },
  EXPIRED: { emoji: '⚫', label: 'Expired', scope: 'key' },
  MODEL_DENIED: { emoji: '🟡', label: 'Model denied', scope: 'mapping' },
  // Distinct from DISCOVERED and QUOTA_EXHAUSTED on purpose: those used 🔵 and
  // 🟣, so "not yet tested", "out of credit" and "server down" were hard to
  // tell apart in the tree. ⚫ is EXPIRED, so this uses the white circle with a
  // slash to read as "the whole endpoint is unreachable".
  PROVIDER_DOWN: { emoji: '🚫', label: 'Provider down', scope: 'provider' },
  TEMP_ERROR: { emoji: '🟤', label: 'Temp error', scope: 'mapping' },
  REQUEST_ERROR: { emoji: '⚪', label: 'Request error', scope: 'request' },
  UNKNOWN_ERROR: { emoji: '⚪', label: 'Unknown error', scope: 'mapping' },
  UNRESOLVED: { emoji: '❓', label: 'Unresolved', scope: 'item' },
  DISABLED: { emoji: '⏸️', label: 'Disabled', scope: 'mapping' },
};

/**
 * Statuses that remove a mapping from rotation entirely (§15).
 * NOTE: MODEL_DENIED only disables that Key x Model mapping — never the
 * whole key. That distinction is the whole point of §35.
 */
export const ROTATION_BLOCKING_KEY_STATUS = new Set([
  STATUS.AUTH_INVALID,
  STATUS.EXPIRED,
  STATUS.QUOTA_EXHAUSTED,
  STATUS.DISABLED,
]);

/** Statuses that are transient and may self-heal on cooldown expiry (§19). */
export const TRANSIENT_STATUS = new Set([
  STATUS.RATE_LIMITED,
  STATUS.TEMP_ERROR,
  STATUS.PROVIDER_DOWN,
]);

/** Terminal states: never auto-rechecked, only manual action (§19). */
export const TERMINAL_STATUS = new Set([
  STATUS.AUTH_INVALID,
  STATUS.EXPIRED,
  STATUS.QUOTA_EXHAUSTED,
]);

export function statusMeta(status) {
  return STATUS_META[status] ?? { emoji: '⚪', label: String(status ?? 'UNKNOWN'), scope: 'mapping' };
}

/** Aggregate a set of mapping statuses into the worst/most actionable one. */
export function aggregateStatus(statuses) {
  if (!statuses.length) return STATUS.UNRESOLVED;
  const priority = [
    STATUS.AUTH_INVALID,
    STATUS.EXPIRED,
    STATUS.QUOTA_EXHAUSTED,
    STATUS.MODEL_DENIED,
    STATUS.RATE_LIMITED,
    STATUS.TEMP_ERROR,
    STATUS.PROVIDER_DOWN,
    STATUS.DISCOVERED,
    STATUS.HEALTHY,
  ];
  for (const candidate of priority) {
    if (statuses.includes(candidate)) return candidate;
  }
  return STATUS.UNKNOWN_ERROR;
}
