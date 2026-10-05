import { timedFetch, readBody } from './http.js';
import { classifyError, classifySuccess } from '../error-classifier.js';
import { CONFIG } from '../config.js';

/**
 * OpenAI-compatible adapter (§9).
 *
 *   GET  {baseURL}/models
 *   POST {baseURL}/chat/completions
 *
 * Special providers later only need a new adapter — router is untouched (§9).
 */
export const openAICompatible = {
  name: 'openai-compatible',

  buildAuthHeaders(secret, { extra = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    return headers;
  },

  buildModelsUrl(baseURL) {
    return `${String(baseURL).replace(/\/+$/, '')}/models`;
  },

  buildChatUrl(baseURL) {
    return `${String(baseURL).replace(/\/+$/, '')}/chat/completions`;
  },

  /** Build a production-shaped inference request (§11). */
  buildRequest({ model, message = CONFIG.probe.message, maxTokens = CONFIG.probe.maxTokens }) {
    return {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
        max_tokens: maxTokens,
        stream: false,
      }),
    };
  },

  /**
   * GET /models — discovery. A PASS here proves authentication and listing,
   * but NOT that inference works (§10).
   */
  async discoverModels({ baseURL, secret, timeoutMs = CONFIG.discoveryTimeoutMs }) {
    const url = this.buildModelsUrl(baseURL);
    const { response, latencyMs, timedOut, error } = await timedFetch(
      url,
      { method: 'GET', headers: this.buildAuthHeaders(secret) },
      timeoutMs
    );

    if (!response) {
      return {
        ok: false,
        latencyMs,
        models: [],
        classification: classifyError({ httpStatus: null, payload: error?.message, context: 'discovery' }),
        timedOut,
      };
    }

    const payload = await readBody(response);

    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        models: [],
        httpStatus: response.status,
        classification: classifyError({
          httpStatus: response.status,
          payload,
          headers: response.headers,
          context: 'discovery',
        }),
      };
    }

    const models = Array.isArray(payload?.data)
      ? payload.data.map((m) => m?.id).filter(Boolean)
      : Array.isArray(payload?.models)
        ? payload.models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
        : [];

    return {
      ok: true,
      latencyMs,
      httpStatus: response.status,
      models,
      classification: classifySuccess({ context: 'discovery', latencyMs, httpStatus: response.status }),
    };
  },

  /**
   * POST /chat/completions — inference probe. This is the highest-confidence
   * evidence in the system (§10, §24).
   */
  async probeModel({ baseURL, secret, model, timeoutMs = CONFIG.probeTimeoutMs, maxTokens }) {
    const url = this.buildChatUrl(baseURL);
    const request = this.buildRequest({ model, maxTokens });
    const { response, latencyMs, timedOut, error } = await timedFetch(
      url,
      { method: request.method, headers: this.buildAuthHeaders(secret), body: request.body },
      timeoutMs
    );

    if (!response) {
      return {
        ok: false,
        latencyMs,
        timedOut,
        classification: classifyError({ httpStatus: null, payload: error?.message, context: 'inference' }),
      };
    }

    const payload = await readBody(response);

    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        httpStatus: response.status,
        classification: classifyError({
          httpStatus: response.status,
          payload,
          headers: response.headers,
          context: 'inference',
        }),
      };
    }

    // Some gateways answer 200 with an error envelope.
    if (payload?.error) {
      return {
        ok: false,
        latencyMs,
        httpStatus: response.status,
        classification: classifyError({ httpStatus: response.status, payload, context: 'inference' }),
      };
    }

    const choice = payload?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text ?? null;

    return {
      ok: true,
      latencyMs,
      httpStatus: response.status,
      content,
      classification: classifySuccess({ context: 'inference', latencyMs, httpStatus: response.status }),
    };
  },

  /** Classify a provider-specific error body beyond the shared baseline. */
  classifyResponse({ httpStatus, payload, headers }) {
    return classifyError({ httpStatus, payload, headers, context: 'inference' });
  },
};

/**
 * Adapter registry (§9). Adding a provider protocol means adding an entry
 * here — never touching router/health logic.
 */
const ADAPTERS = new Map([[openAICompatible.name, openAICompatible]]);

export function registerAdapter(adapter) {
  ADAPTERS.set(adapter.name, adapter);
}

export function getAdapter(protocol = 'openai-compatible') {
  return ADAPTERS.get(protocol) ?? openAICompatible;
}

export function listAdapters() {
  return [...ADAPTERS.keys()];
}
