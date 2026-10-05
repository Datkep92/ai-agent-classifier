import { normalizeName } from './util.js';

/**
 * URL normalization (§8).
 *
 * Must defend against:
 *   - /v1/v1                duplicate version segment
 *   - //chat/completions    double slash + endpoint already appended
 *   - trailing slash
 *   - base URL that already contains a full endpoint
 *
 * Rules deliberately conservative:
 *   - We do NOT append /v1 unless there is evidence the provider wants it
 *     (§8: "Khong tu noi /v1 neu chua co bang chung").
 *   - We do NOT invent providers. Normalization is pure string work.
 */

const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/embeddings',
  '/responses',
  '/messages',
  '/models',
];

/** Strip an OpenAI-style endpoint suffix so we get back to a base URL. */
export function stripEndpoint(pathname) {
  let path = pathname;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return path;
}

/** Collapse repeated identical version segments: /v1/v1 -> /v1 */
function collapseVersionSegments(pathname) {
  return pathname.replace(/\/(v\d+)(\/\1)+/gi, '/$1');
}

/** Collapse accidental double slashes inside the path. */
function collapseSlashes(pathname) {
  return pathname.replace(/\/{2,}/g, '/');
}

/**
 * Normalize any pasted URL into a canonical base URL string.
 * Returns null when input is not parseable as an http(s) URL.
 */
export function normalizeBaseURL(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw) return null;

  // Tolerate scheme-less input like "api.openai.com/v1"
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol)) return null;
  if (!url.hostname) return null;

  // Drop credentials + query + hash: they are not part of provider identity.
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';

  // Lowercase host, drop default ports, drop www? No - www may matter.
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  let path = stripEndpoint(url.pathname);
  path = collapseVersionSegments(path);
  path = collapseSlashes(path);
  // Remove trailing slash (but keep root "/").
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '/') path = '';
  // Unify trailing version marker: ensure single trailing slash on /vN.
  url.pathname = path;

  let out = url.toString();
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Candidate base URLs to try when discovering an unknown provider.
 * Ordered most-likely first. We only include /v1 as a *candidate to test*,
 * never as an assumption (§8).
 */
export function baseUrlCandidates(input) {
  const normalized = normalizeBaseURL(input);
  if (!normalized) return [];
  const candidates = [normalized];
  const withoutV1 = normalized.replace(/\/v\d+$/, '');
  if (withoutV1 !== normalized) {
    // Already has /v1 -> also try the bare host.
    candidates.push(withoutV1);
  } else {
    // No version segment -> most OpenAI-compatible providers use /v1.
    candidates.push(`${normalized}/v1`);
  }
  return [...new Set(candidates)];
}

/** Stable dedupe key for a provider (§25: normalized baseURL). */
export function providerIdentity(baseURL) {
  return normalizeBaseURL(baseURL) ?? String(baseURL ?? '').trim().toLowerCase();
}

/** Stable dedupe key for a model within a provider (§25). */
export function modelIdentity(providerId, modelId) {
  return `${providerId}::${String(modelId ?? '').trim()}`;
}

/** Stable dedupe key for a mapping (§25: provider + model + key). */
export function mappingIdentity(providerId, modelId, keyId) {
  return `${providerId}::${String(modelId ?? '').trim()}::${keyId}`;
}

/** Derive a human-friendly provider name from a base URL. */
export function providerNameFromURL(baseURL) {
  try {
    const url = new URL(normalizeBaseURL(baseURL) ?? baseURL);
    const host = url.hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const core = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : host;
  } catch {
    return 'Custom';
  }
}

/** Normalize a model id for display while preserving the provider's exact id. */
export function normalizeModelId(input) {
  return String(input ?? '').trim();
}

/** Loose comparison used only for name-similarity evidence, never identity. */
export function modelsLooselyMatch(a, b) {
  return normalizeName(a) === normalizeName(b) && Boolean(normalizeName(a));
}
