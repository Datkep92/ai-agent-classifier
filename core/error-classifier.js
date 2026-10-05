import { STATUS } from './statuses.js';

/**
 * Classify a failed (or notable) API response into a status + metadata.
 * Never trusts HTTP status alone (§13): inspects error.type, error.code,
 * error.message, Retry-After, and body text.
 *
 * Returns: { status, httpStatus, retryAfterMs, scope, message, code }
 */

const QUOTA_PATTERNS = [
  /insufficient[_ -]?(?:credit|balance|fund|quota)/i,
  /credit balance is too low/i,
  /exceeded your current quota/i,
  /quota (?:exceeded|exhausted)/i,
  /out of credits?/i,
  /billing/i,
  /payment required/i,
];

const EXPIRED_PATTERNS = [
  /\bexpired\b/i,
  /\bexpiration\b/i,
  /\bdeactivated\b/i,
  /\brevoked\b/i,
  /token (?:has )?expired/i,
];

const AUTH_PATTERNS = [
  /invalid[ _-]?api[ _-]?key/i,
  /incorrect api key/i,
  /unauthorized/i,
  /authentication/i,
  /no api key/i,
  /missing api key/i,
  /permission denied/i,
  /forbidden/i,
];

const MODEL_DENIED_PATTERNS = [
  /model .{0,40}not (?:allowed|permitted|authorized)/i,
  /not permitted to use (?:the )?model/i,
  /you do not have access to (?:the )?model/i,
  /model_access_denied/i,
  /model .{0,30}not available (?:to|for) (?:your|this)/i,
];

const MODEL_NOT_FOUND_PATTERNS = [
  /model (?:not found|does not exist|no such model)/i,
  /unknown model/i,
  /invalid model/i,
  /model_not_found/i,
  /no such model/i,
  /model .{0,30}(?:unavailable|deprecated|retired)/i,
];

const RATE_LIMIT_PATTERNS = [/rate[ _-]?limit/i, /too many requests/i, /slow down/i];

function anyMatch(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const get = (name) => {
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()];
  };
  const raw = get('retry-after') ?? get('Retry-After') ?? get('x-ratelimit-reset-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/** Extract the most useful message string from assorted provider error shapes. */
function extractMessage(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  const err = payload.error ?? payload;
  if (typeof err === 'string') return err;
  const parts = [
    err?.message,
    err?.msg,
    err?.detail,
    err?.description,
    typeof err?.code === 'string' ? err.code : null,
    payload?.message,
    payload?.detail,
  ].filter((v) => typeof v === 'string' && v.trim());
  if (parts.length) return parts.join(' | ');
  return JSON.stringify(payload).slice(0, 300);
}

function extractCode(payload) {
  const err = payload?.error ?? payload;
  const candidates = [err?.code, err?.type, payload?.code, payload?.type, payload?.error_type];
  return candidates.find((v) => typeof v === 'string' && v.trim()) ?? null;
}

/**
 * @param {object} args
 * @param {number|null} args.httpStatus
 * @param {any} args.payload        parsed response body (or raw text)
 * @param {Headers|object} args.headers
 * @param {string} args.context      'discovery' | 'inference' | 'connectivity'
 */
export function classifyError({ httpStatus, payload, headers, context = 'inference' }) {
  const message = extractMessage(payload);
  const code = extractCode(payload);
  const haystack = `${message} ${code ?? ''}`;
  const retryAfterMs = parseRetryAfterMs(headers);
  const base = { httpStatus: httpStatus ?? null, retryAfterMs, code, message: message.slice(0, 300) };

  // Order matters: check semantic body content before bare status codes.
  if (anyMatch(haystack, MODEL_DENIED_PATTERNS)) {
    return { ...base, status: STATUS.MODEL_DENIED, scope: 'mapping' };
  }

  if (httpStatus === 429 || anyMatch(haystack, RATE_LIMIT_PATTERNS)) {
    // §13: do NOT treat every 429 as quota exhaustion. Only if the body
    // explicitly says quota/credit/balance is exhausted.
    if (anyMatch(haystack, QUOTA_PATTERNS)) {
      return { ...base, status: STATUS.QUOTA_EXHAUSTED, scope: 'key' };
    }
    return { ...base, status: STATUS.RATE_LIMITED, scope: 'mapping', retryAfterMs };
  }

  if (anyMatch(haystack, QUOTA_PATTERNS) || httpStatus === 402) {
    return { ...base, status: STATUS.QUOTA_EXHAUSTED, scope: 'key' };
  }

  if (anyMatch(haystack, MODEL_NOT_FOUND_PATTERNS)) {
    // §13: model not found does NOT mean the key is invalid.
    return { ...base, status: STATUS.MODEL_DENIED, scope: 'mapping' };
  }

  if (anyMatch(haystack, EXPIRED_PATTERNS)) {
    return { ...base, status: STATUS.EXPIRED, scope: 'key' };
  }

  if (httpStatus === 401 || httpStatus === 403 || anyMatch(haystack, AUTH_PATTERNS)) {
    return { ...base, status: STATUS.AUTH_INVALID, scope: 'key' };
  }

  if (httpStatus >= 500) {
    // Provider-side. 5xx from a gateway can be provider down.
    return { ...base, status: STATUS.PROVIDER_DOWN, scope: 'provider' };
  }

  if (httpStatus === 400 || httpStatus === 422 || httpStatus === 404) {
    // Malformed request / bad endpoint shape. §35: do not rotate the whole
    // key pool on a request-format error.
    if (httpStatus === 404 && context === 'discovery') {
      return { ...base, status: STATUS.UNKNOWN_ERROR, scope: 'provider', notFound: true };
    }
    return { ...base, status: STATUS.REQUEST_ERROR, scope: 'request' };
  }

  if (httpStatus === 408) {
    return { ...base, status: STATUS.TEMP_ERROR, scope: 'mapping' };
  }

  if (!httpStatus) {
    // Network/timeout/abort — no HTTP response at all.
    return { ...base, status: STATUS.TEMP_ERROR, scope: 'mapping' };
  }

  return { ...base, status: STATUS.UNKNOWN_ERROR, scope: 'mapping' };
}

/** Classify a successful response — inference PASS is high-confidence evidence (§10, §24). */
export function classifySuccess({ context, latencyMs, httpStatus }) {
  if (context === 'inference') {
    return {
      status: STATUS.HEALTHY,
      evidence: 'inference',
      httpStatus,
      latencyMs,
    };
  }
  if (context === 'discovery') {
    return {
      status: STATUS.DISCOVERED,
      evidence: 'discovery',
      httpStatus,
      latencyMs,
    };
  }
  return { status: STATUS.HEALTHY, evidence: 'connectivity', httpStatus, latencyMs };
}
