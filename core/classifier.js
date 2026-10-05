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

/**
 * Known key prefix hints -> provider hint. Hint only, never proof (§6).
 *
 * Ordering matters: the longest / most specific prefixes come first so that
 * "sk-or-v1-" is not shadowed by "sk-". All entries are real, documented
 * vendor formats — this is a lookup table, not a heuristic.
 *
 * The list covers the non-LLM vendors too (GitHub, GitLab, HuggingFace,
 * Replicate, Stripe, NVIDIA, Cohere). That matters because those payloads are
 * indistinguishable from model ids by shape alone: "ghp_16C7e42F..." contains
 * the letter run "ghp" and would otherwise read as a model name.
 */
export const KEY_PREFIX_HINTS = [
  // OpenAI-compatible LLM gateways and vendors.
  { prefix: 'oc_sk_', providerHint: 'OpenCode' },
  { prefix: 'sk-or-v1-', providerHint: 'OpenRouter' },
  { prefix: 'sk-or-', providerHint: 'OpenRouter' },
  { prefix: 'sk-proj-', providerHint: 'OpenAI' },
  { prefix: 'sk-ant-', providerHint: 'Anthropic' },
  { prefix: 'sk-', providerHint: 'OpenAI-compatible' },
  { prefix: 'AIza', providerHint: 'Google' },
  { prefix: 'gsk_', providerHint: 'Groq' },
  { prefix: 'xai-', providerHint: 'xAI' },
  { prefix: 'csk-', providerHint: 'Cohere' },
  { prefix: 'co-', providerHint: 'Cohere' },
  { prefix: 'nvapi-', providerHint: 'NVIDIA' },

  // Non-LLM vendors whose tokens are model-shaped by accident.
  { prefix: 'ghp_', providerHint: 'GitHub' },
  { prefix: 'gho_', providerHint: 'GitHub' },
  { prefix: 'ghu_', providerHint: 'GitHub' },
  { prefix: 'ghs_', providerHint: 'GitHub' },
  { prefix: 'ghr_', providerHint: 'GitHub' },
  { prefix: 'github_pat_', providerHint: 'GitHub' },
  { prefix: 'glpat-', providerHint: 'GitLab' },
  { prefix: 'hf_', providerHint: 'HuggingFace' },
  { prefix: 'r8_', providerHint: 'Replicate' },
  { prefix: 'sk_live_', providerHint: 'Stripe' },
  { prefix: 'sk_test_', providerHint: 'Stripe' },
  { prefix: 'pk_live_', providerHint: 'Stripe' },
  { prefix: 'pk_test_', providerHint: 'Stripe' },
  { prefix: 'rk_live_', providerHint: 'Stripe' },
  { prefix: 'rk_test_', providerHint: 'Stripe' },
  { prefix: 'whsec_', providerHint: 'Stripe' },
  { prefix: 'AKIA', providerHint: 'AWS' },
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

/**
 * Word-like segment: 3+ consecutive letters (§6).
 *
 * This is the structural signal that separates a model id from key material.
 * Model ids are composed of readable words -- sonnet, instruct, distill,
 * coder, turbo, preview. Key payloads are random bytes, so a run of three
 * letters is uncommon by chance and long runs are rarer still.
 *
 * Deliberately measured, not assumed: see tests/cases-classifier.js, which
 * asserts every corpus model contains one and every corpus key is judged by
 * a known prefix first (CL2, CL6).
 */
const WORD_LIKE = /[a-z]{3,}/i;

/** Split a token on every structural separator used by ids and keys alike. */
function structuralSegments(text) {
  return text.split(/[-_./:]+/).filter(Boolean);
}

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

/**
 * Hostname detection, by structure rather than by regex appetite (§6).
 *
 * The old rule was "contains dots and no spaces", which also matched every
 * versioned model id: gemini-2.0-flash-exp, qwen2.5-coder-32b-instruct,
 * phi-3.5-mini-instruct and gpt-4.1-2025-04-14 were all read as URLs.
 *
 * A hostname's distinguishing feature is its TLD: the LAST dotted label must be
 * alphabetic. A model id may carry dots, but its final dotted label is a
 * version or size number (2.0, 2.5, 3.5, 3.3, 4.1). One rule separates both.
 */
function looksLikeUrl(text) {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  // Pure version numbers (1.2.3) are not hostnames even though they match
  // the dotted-segment shape below.
  if (/^[\d.]+$/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;

  // Only the authority can prove a host; a trailing path is ignored here.
  const authority = trimmed.split(/[/?#]/)[0];
  const labels = authority.split('.');
  if (labels.length < 2) return false;
  if (labels.some((label) => !/^[\w-]+$/.test(label))) return false;
  // The TLD is alphabetic. This is what excludes model version dots.
  return /^[a-z]{2,}$/i.test(labels[labels.length - 1]);
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

/**
 * Prefix-free key discriminator (§6).
 *
 * The prefix table cannot cover every vendor, and the entropy test alone
 * misfires on real model ids: "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF"
 * scores 4.43 bits/char, higher than the weakest real key at 3.84. Entropy
 * was measured and rejected as a separator for exactly that reason.
 *
 * The structural fact that does hold: every model id is COMPOSED — it has at
 * least one - _ . / : boundary between meaningful parts. A key with no known
 * prefix is an unbroken opaque blob ("a1b2c3d4e5f6a7b8..."). So an unbroken
 * high-entropy token with no prefix is a key, whatever its length.
 *
 * The converse is deliberately NOT used to invent models: the model branch
 * requires its own positive evidence.
 */
function looksLikePrefixFreeKey(text) {
  const trimmed = text.trim();
  if (/[-_./:]/.test(trimmed)) return false; // composed -> model-ish, not a blob
  return looksLikeApiKey(trimmed);
}

/**
 * Model-id detection: structural, not keyword-based (§6).
 *
 * Two independent signals, either of which is enough:
 *
 *   1. a WORD-LIKE segment (3+ letters) -- sonnet, instruct, distill. Model
 *      ids are built from words; key payloads are random, so they lack one.
 *      This is what rescues claude-3-5-sonnet-20241022, whose "high entropy"
 *      previously pushed it into the key branch: the trailing 20241022 looks
 *      random but the word "sonnet" cannot.
 *
 *   2. a known vendor family prefix -- kept from before as a fallback for
 *      short ids with no word segment.
 *
 * A repo path (nvidia/Llama-3.1-Nemotron-70B-Instruct-HF) is a model too: it
 * is not a host, because its last dotted label is a version, not a TLD.
 */
function looksLikeModel(text) {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (looksLikeUrl(trimmed)) return false;
  if (trimmed.length > 120) return false;
  if (/^[\d.]+$/.test(trimmed)) return false; // version number like 1.2.3

  // Signal 1: a multi-part id with a readable word segment.
  //
  // Requiring more than one segment is essential. A bare English word has a
  // word segment by definition, so without this "some totally unknown
  // content" classified as four models and lost its real UNKNOWN status.
  const segments = structuralSegments(trimmed);
  if (segments.length > 1 && segments.some((segment) => WORD_LIKE.test(segment))) return true;

  // Signal 2: vendor family prefix.
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

  if (looksLikePrefixFreeKey(value)) {
    // No known prefix and no separators: an opaque blob. Decided before the
    // model branch because a blob can never be a composed model id.
    return {
      type: ITEM_TYPE.API_KEY,
      confidence: CONFIDENCE.MEDIUM,
      value,
      providerHint: null,
      reason: 'opaque blob with no structural separators',
    };
  }

  if (looksLikeApiKey(value) && !looksLikeModel(value)) {
    // A word-like segment means this is a name, not random bytes. Without this
    // exclusion, every dated model id (claude-3-5-sonnet-20241022) satisfied
    // the entropy test and was classified as a key.
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
