import { classifyItem, classifyLabelled, ITEM_TYPE, CONFIDENCE } from './classifier.js';
import { normalizeBaseURL } from './normalizer.js';

/**
 * Smart Ingest (§5).
 *
 * One textarea. User pastes anything: URLs, models, keys, JSON config,
 * labelled text, mixed order. We tokenize first, classify each token.
 * We NEVER drop input we cannot understand (§3, §35) — it goes to Unresolved.
 */

const LABEL_RE = /^[\s"'{,\[]*([A-Za-z_][A-Za-z0-9_. -]{0,30}?)\s*["']?\s*[:=]\s*(.+)$/;

/** Keys that commonly hold a base URL inside a JSON config. */
const URL_HINT_KEYS = /^(base_?url|baseurl|endpoint|api_?url|api_?base|url|host|server|openai_?base_?url|anthropic_?base_?url|openai_?api_?base)$/i;
const MODEL_HINT_KEYS = /^(model|model_?id|model_?name|engine|model_?ref|default_?model)$/i;
const KEY_HINT_KEYS = /^(api_?key|apikey|key|token|secret|auth_?token|bearer|password|api_?token)$/i;

/**
 * Walk an arbitrary JSON value and yield {label, value, path} leaves that
 * look like url/model/key. Handles nested objects/arrays and common
 * provider config shapes.
 */
function harvestJson(value, path = '', out = []) {
  if (value === null || value === undefined) return out;

  if (Array.isArray(value)) {
    value.forEach((item, index) => harvestJson(item, `${path}[${index}]`, out));
    return out;
  }

  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (typeof val === 'string') {
        out.push({ label: key, value: val, path: nextPath });
      } else {
        harvestJson(val, nextPath, out);
      }
    }
    return out;
  }

  if (typeof value === 'string') {
    out.push({ label: '', value, path });
  }
  return out;
}

function classifyJsonLeaf({ label, value, path }) {
  const key = String(label ?? '').replace(/[^A-Za-z0-9_]/g, '');
  const effectiveLabel = label || (path ? path.split(/[.[\]]+/).pop() : '');

  if (key && URL_HINT_KEYS.test(key)) {
    const normalized = normalizeBaseURL(value);
    if (normalized) {
      return {
        type: ITEM_TYPE.URL,
        confidence: CONFIDENCE.EXACT,
        value: normalized,
        providerHint: null,
        reason: `json key "${key}"`,
        origin: path,
      };
    }
  }
  if (key && KEY_HINT_KEYS.test(key)) {
    const classified = classifyItem(value);
    if (classified.type === ITEM_TYPE.API_KEY) {
      return { ...classified, confidence: CONFIDENCE.HIGH, reason: `json key "${key}"`, origin: path };
    }
    // Trust the label even if the shape heuristic is unsure.
    if (value.trim().length >= 8) {
      return {
        type: ITEM_TYPE.API_KEY,
        confidence: CONFIDENCE.MEDIUM,
        value: value.trim(),
        providerHint: null,
        reason: `json key "${key}" (labelled)`,
        origin: path,
      };
    }
  }
  if (key && MODEL_HINT_KEYS.test(key)) {
    return {
      type: ITEM_TYPE.MODEL,
      confidence: CONFIDENCE.HIGH,
      value: value.trim(),
      providerHint: null,
      reason: `json key "${key}"`,
      origin: path,
    };
  }

  const classified = classifyItem(value);
  return { ...classified, origin: path || undefined };
}

/**
 * Tokenize raw text. Handles:
 *  - full JSON document
 *  - labelled lines ("model: gpt-4")
 *  - comma/whitespace/newline separated loose tokens
 *  - JSON embedded in surrounding text
 */
function tokenize(text) {
  const trimmed = text.trim();
  const tokens = [];

  // Whole-document JSON first.
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      return { kind: 'json', json: parsed, tokens };
    } catch {
      // fall through: maybe JSON embedded in prose
    }
  }

  // Embedded JSON (first {...} or [...] block).
  const embedded = trimmed.match(/[{[\][\s\S]*?[}\]]/);
  if (embedded && /[{[]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(embedded[0]);
      return { kind: 'json', json: parsed, tokens };
    } catch {
      /* not valid json, continue */
    }
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Split on commas/semicolons FIRST so each `label: value` pair stays
    // intact, then parse each piece. Doing label-matching first would make
    // `a: 1, b: 2` swallow everything after the first comma.
    const chunks = line
      .split(/\r?\n|\s*[,;]\s*/)
      .map((piece) => piece.trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      // A bare URL contains "://" and must never be read as "label: value".
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(chunk)) {
        tokens.push({ value: chunk });
        continue;
      }

      const labelled = chunk.match(LABEL_RE);
      if (labelled) {
        const [, label, rest] = labelled;
        const value = rest.trim();
        // A labelled value may itself be a JSON blob.
        if (/^[[{]/.test(value)) {
          try {
            tokens.push({ label, json: JSON.parse(value) });
            continue;
          } catch {
            /* not valid json; fall through as plain value */
          }
        }
        // Strip wrapping quotes from the value.
        tokens.push({ label, value: value.replace(/^["']|["']$/g, '') });
        continue;
      }

      // Loose tokens: keep full URLs (which may contain no spaces anyway) and
      // otherwise split on whitespace.
      if (/^https?:\/\/\S+$/i.test(chunk) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(chunk)) {
        tokens.push({ value: chunk });
        continue;
      }
      const parts = chunk.match(/"[^"]+"|'[^']+'|\S+/g) ?? [chunk];
      for (const part of parts) {
        tokens.push({ value: part.replace(/^["']|["']$/g, '') });
      }
    }
  }

  return { kind: 'tokens', tokens };
}

/**
 * Main entry: raw paste -> classified items.
 * @param {string} raw
 * @returns {Array<{type, confidence, value, providerHint, reason, origin}>}
 */
export function ingest(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];

  const { kind, json, tokens } = tokenize(raw);
  const items = [];

  if (kind === 'json') {
    for (const leaf of harvestJson(json)) {
      if (!leaf.value?.trim()) continue;
      items.push(classifyJsonLeaf(leaf));
    }
    // Also let the top-level object itself be re-pasted as config if the
    // harvest produced nothing (e.g. {"a":1}).
    if (!items.length) {
      items.push({
        type: ITEM_TYPE.JSON_CONFIG,
        confidence: CONFIDENCE.EXACT,
        value: JSON.stringify(json),
        providerHint: null,
        reason: 'json document',
      });
    }
    return dedupeItems(items);
  }

  for (const token of tokens) {
    if (!token.value?.trim()) continue;
    if (token.json !== undefined) {
      for (const leaf of harvestJson(token.json)) {
        if (!leaf.value?.trim()) continue;
        items.push(classifyJsonLeaf(leaf));
      }
      continue;
    }
    const classified = token.label
      ? classifyLabelled(token.label, token.value)
      : classifyItem(token.value);
    items.push({ ...classified, origin: token.label ? `label:${token.label}` : undefined });
  }

  return dedupeItems(items);
}

/** Dedupe by type+value so re-pasting never doubles up (§25). */
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.type}::${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Group classified items by type for the import pipeline. */
export function groupItems(items) {
  const groups = {
    urls: [],
    models: [],
    keys: [],
    configs: [],
    unknown: [],
  };
  for (const item of items) {
    if (item.type === ITEM_TYPE.URL) groups.urls.push(item);
    else if (item.type === ITEM_TYPE.MODEL) groups.models.push(item);
    else if (item.type === ITEM_TYPE.API_KEY) groups.keys.push(item);
    else if (item.type === ITEM_TYPE.JSON_CONFIG) groups.configs.push(item);
    else groups.unknown.push(item);
  }
  return groups;
}
