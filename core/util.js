import { CONFIG } from './config.js';

/** Stable JSON stringify (sorted keys) for deterministic hashing/compare. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** SHA-256 hex using Web Crypto (Node 18+ and modern Safari both expose it). */
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Short, stable, non-reversible fingerprint for dedupe + display.
 * We never store or log the raw secret alongside it (§4).
 */
export async function fingerprintSecret(secret) {
  const hash = await sha256Hex(`fp:${secret}`);
  return `fp_${hash.slice(0, 16)}`;
}

/** Mask a secret for UI/logs: keep head+tail, elide middle. Never returns full secret. */
export function maskSecret(secret) {
  const s = String(secret ?? '');
  const { head, tail } = CONFIG.mask;
  if (s.length <= head + tail) {
    return `${'*'.repeat(Math.max(1, s.length))}`;
  }
  return `${s.slice(0, head)}${'*'.repeat(Math.max(4, s.length - head - tail))}${s.slice(-tail)}`;
}

/** Sanitize error text before storing/logging — strip secrets and cap length. */
export function sanitizeError(input, secrets = []) {
  let text = typeof input === 'string' ? input : String(input?.message ?? input ?? '');
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    text = text.split(secret).join(maskSecret(secret));
  }
  // Strip common bearer/token shapes defensively.
  text = text.replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***');
  text = text.replace(/((?:api[-_]?key|token|secret)["'\s:=]+)[A-Za-z0-9._\-]{12,}/gi, '$1***');
  return text.slice(0, 500);
}

export function nowMs() {
  return Date.now();
}

export function isoNow() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clamp a number into [min, max]. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Compare two strings loosely (used for name-similarity evidence, not identity). */
export function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Cheap 0..1 similarity via token overlap + length ratio. Deterministic. */
export function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const setB = new Set(nb.split(''));
  let shared = 0;
  for (const ch of new Set(na)) if (setB.has(ch)) shared++;
  const union = new Set([...new Set(na), ...setB]).size || 1;
  const overlap = shared / union;
  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  return clamp(overlap * 0.6 + lenRatio * 0.4, 0, 1);
}

/** Run tasks with bounded concurrency; yields between tasks so UI stays responsive. */
export async function mapWithConcurrency(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
      onProgress?.(index + 1, items.length, items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Generate a short unique id (not a secret). */
let idCounter = 0;
export function makeId(prefix = 'id') {
  idCounter = (idCounter + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}
