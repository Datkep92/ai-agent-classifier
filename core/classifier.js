import { normalizeBaseURL } from './normalizer.js';
import { normalizeName } from './util.js';

/**
 * Item classification (§6).
 *
 * Types: URL | MODEL | API_KEY | JSON_CONFIG | UNKNOWN
 * Confidence: EXACT | HIGH | MEDIUM | LOW | UNRESOLVED
 *
 * Key prefixes (oc_sk_, sk-or-, sk-, ...) are HINTS ONLY. We never conclude
 * a provider from a prefix alone (§6).
 */

export const ITEM_TYPE = {
  URL: 'URL',
  MODEL: 'MODEL',
  API_KEY: 'API_KEY',
  JSON_CONFIG: 'JSON_CONFIG',
  UNKNOWN: 'UNKNOWN',
};

export const CONFIDENCE = {
  EXACT: 'EXACT',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNRESOLVED: 'UNRESOLVED',
};

/** Known key prefix hints -> provider hint. Hint only, never proof (§6). */
export const KEY_PREFIX_HINTS = [
  { prefix: 'oc_sk_', providerHint: 'OpenCode' },
  { prefix: 'sk-or-', providerHint: 'OpenRouter' },
  { prefix: 'sk-or-v1-', providerHint: 'OpenRouter' },
  { prefix: 'sk-proj-', providerHint: 'OpenAI' },
  { prefix: 'sk-ant-', providerHint: 'Anthropic' },
  { prefix: 'sk-', providerHint: 'OpenAI-compatible' },
  { prefix: 'AIza', providerHint: 'Google' },
  { prefix: 'gsk_', providerHint: 'Groq' },
  { prefix: 'xai-', providerHint: 'xAI' },
];

/** Domains that strongly imply a provider (still requires probe to verify). */
const PROVIDER_DOMAIN_HINTS = [
  { domain: 'openai.com', providerHint: 'OpenAI' },
  { domain: 'openrouter.ai', providerHint: 'OpenRouter' },
  { domain: 'opencode.ai', providerHint: 'OpenCode' },
  { domain: 'anthropic.com', providerHint: 'Anthropic' },
  { domain: 'groq.com', providerHint: 'Groq' },
  { domain: 'x.ai', providerHint: 'xAI' },
  { domain: 'googleapis.com', providerHint: 'Google' },
  { domain: 'together.xyz', providerHint: 'Together' },
  { domain: 'deepseek.com', providerHint: 'DeepSeek' },
];

/** Heuristic: what a model id tends to look like. */
const MODEL_NAME_PATTERNS = [
  /^[a-z0-9]+[._-][a-z0-9._-]+$/i,
  /^(?:gpt|claude|gemini|llama|mistral|deepseek|qwen|glm|kimi|grok|phi|nemotron|command|r1|o1|o3)[-_]/i,
];

function hasJsonShape(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksLikeUrl(text) {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  // Pure version numbers (1.2.3) are not hostnames even though they match
  // the dotted-segment shape below.
  if (/^[\d.]+$/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  // scheme-less host with a path and a TLD
  return /^[\w-]+(\.[\w-]+)+(\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?$/i.test(trimmed);
}

/**
 * Key detection. Deliberately conservative: high entropy, no spaces,
 * recognizable prefix OR long opaque token.
 */
function looksLikeApiKey(text) {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (trimmed.length < 20 || trimmed.length > 400) return false;
  const prefixHit = KEY_PREFIX_HINTS.find((h) => trimmed.toLowerCase().startsWith(h.prefix.toLowerCase()));
  if (prefixHit) return true;
  // Opaque mixed token: letters+digits, allow -_ . and no separators like :
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    const hasLetter = /[A-Za-z]/.test(trimmed);
    const hasDigit = /\d/.test(trimmed);
    const variety = new Set(trimmed.replace(/[^A-Za-z0-9]/g, '').split('')).size;
    return hasLetter && hasDigit && variety >= 12;
  }
  return false;
}

function looksLikeModel(text) {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (looksLikeUrl(trimmed)) return false;
  if (trimmed.length > 120) return false;
  if (/^[\d.]+$/.test(trimmed)) return false; // version number like 1.2.3
  return MODEL_NAME_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Classify a single token/item.
 * @returns {{type, confidence, value, providerHint, reason}}
 */
export function classifyItem(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return { type: ITEM_TYPE.UNKNOWN, confidence: CONFIDENCE.UNRESOLVED, value, reason: 'empty' };
  }

  if (hasJsonShape(value)) {
    return { type: ITEM_TYPE.JSON_CONFIG, confidence: CONFIDENCE.EXACT, value, reason: 'valid json object/array' };
  }

  if (looksLikeUrl(value)) {
    const normalized = normalizeBaseURL(value);
    const domainHint = PROVIDER_DOMAIN_HINTS.find((h) => normalized?.includes(h.domain));
    return {
      type: ITEM_TYPE.URL,
      confidence: CONFIDENCE.EXACT,
      value: normalized ?? value,
      providerHint: domainHint?.providerHint ?? null,
      reason: 'url shape',
    };
  }

  const prefixHit = KEY_PREFIX_HINTS.find((h) => value.toLowerCase().startsWith(h.prefix.toLowerCase()));
  if (prefixHit && looksLikeApiKey(value)) {
    return {
      type: ITEM_TYPE.API_KEY,
      confidence: CONFIDENCE.HIGH,
      value,
      providerHint: prefixHit.providerHint,
      reason: `known key prefix ${prefixHit.prefix}`,
    };
  }

  if (looksLikeApiKey(value)) {
    return {
      type: ITEM_TYPE.API_KEY,
      confidence: CONFIDENCE.MEDIUM,
      value,
      providerHint: null,
      reason: 'high-entropy opaque token',
    };
  }

  if (looksLikeModel(value)) {
    return {
      type: ITEM_TYPE.MODEL,
      confidence: CONFIDENCE.MEDIUM,
      value,
      providerHint: null,
      reason: 'model id shape',
    };
  }

  return { type: ITEM_TYPE.UNKNOWN, confidence: CONFIDENCE.UNRESOLVED, value, reason: 'no confident match' };
}

/**
 * Classify labelled text like "baseURL: https://..." or "model: gpt-4".
 * Returns a refined classification when the label is meaningful (§5).
 */
export function classifyLabelled(label, value) {
  const base = classifyItem(value);
  const l = String(label ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const forceType = (type, confidence, reason) => ({ ...base, type, confidence, reason });

  if (/baseurl|endpoint|apiurl|url|host|server|base/.test(l) && base.type === ITEM_TYPE.URL) {
    return forceType(ITEM_TYPE.URL, CONFIDENCE.EXACT, `labelled url (${label})`);
  }
  if (/model|modelid|modelname|name|engine/.test(l) && base.type !== ITEM_TYPE.JSON_CONFIG) {
    return forceType(ITEM_TYPE.MODEL, CONFIDENCE.HIGH, `labelled model (${label})`);
  }
  if (/apikey|key|token|secret|authorization|bearer|password/.test(l) && base.type !== ITEM_TYPE.URL) {
    return forceType(ITEM_TYPE.API_KEY, CONFIDENCE.HIGH, `labelled key (${label})`);
  }
  return base;
}

/** Heuristic provider guess from a model id — LOW evidence only (§24). */
export function providerHintFromModel(modelId) {
  const n = normalizeName(modelId);
  if (!n) return null;
  if (n.startsWith('gpt') || n.startsWith('o1') || n.startsWith('o3')) return 'OpenAI';
  if (n.startsWith('claude')) return 'Anthropic';
  if (n.startsWith('gemini')) return 'Google';
  if (n.startsWith('llama')) return 'Meta';
  return null;
}
