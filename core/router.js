import { STATUS } from './statuses.js';
import { computeScore, isEligible, isProviderAvailable } from './health.js';
import { nowMs } from './util.js';
import { getAdapter } from './adapters/openai-compatible.js';
import { CONFIG } from './config.js';

/**
 * Smart Router (§15).
 *
 * Rotation order: KEY -> MODEL -> PROVIDER.
 *
 * Example ordering from the plan:
 *   OpenCode / Space Bunny  -> Key1, Key2, Key3
 *   OpenCode / Fledge       -> Key1, Key2
 *   OpenCode / Nemotron    -> Key1
 *   OpenRouter / Space Bunny -> Key1   (provider fallback)
 *
 * Skips (per §15): AUTH_INVALID, EXPIRED, QUOTA_EXHAUSTED, disabled,
 * active cooldown, MODEL_DENIED — but MODEL_DENIED only removes that one
 * mapping, never the whole key (test I).
 */

export class Router {
  constructor(registry) {
    this.registry = registry;
  }

  /** Load the full eligible candidate set, scored and sorted. */
  async candidates({ modelId = null, now = nowMs() } = {}) {
    const [providers, keys, mappings] = await Promise.all([
      this.registry.listProviders(),
      this.registry.listKeys(),
      this.registry.listMappings(),
    ]);

    const providerById = new Map(providers.map((p) => [p.id, p]));
    const keyById = new Map(keys.map((k) => [k.id, k]));
    const providerModelIds = await this._modelIdsByProvider();

    const list = [];
    for (const mapping of mappings) {
      const key = keyById.get(mapping.keyId);
      const provider = providerById.get(mapping.providerId);
      if (!key || !provider) continue;

      if (modelId && mapping.modelId !== modelId) continue;
      if (!isEligible(mapping, key, { now })) continue;
      if (!isProviderAvailable(provider.breaker, { now })) continue;

      list.push({
        mapping,
        key,
        provider,
        model: providerModelIds.get(mapping.modelId) ?? null,
        score: computeScore(mapping, { now }),
      });
    }

    return list;
  }

  async _modelIdsByProvider() {
    const models = await this.registry.listModels();
    const byModelId = new Map();
    for (const model of models) {
      if (!byModelId.has(model.modelId)) byModelId.set(model.modelId, model);
    }
    return byModelId;
  }

  /**
   * Pick the best candidate. Ordering:
   *   1. higher score
   *   2. same model before a different model (model preference)
   *   3. provider fallback last
   */
  async pick({ preferredModelId = null, exclude = [], now = nowMs() } = {}) {
    const all = await this.candidates({ now });
    const excluded = new Set(exclude);

    const ranked = all
      .filter((c) => !excluded.has(c.mapping.id))
      .map((c) => ({
        ...c,
        rankScore:
          c.score +
          (c.mapping.modelId === preferredModelId ? 1000 : 0) +
          (c.mapping.verified ? 100 : 0),
      }))
      .sort((a, b) => b.rankScore - a.rankScore || (a.mapping.lastSuccessAt ?? '').localeCompare(b.mapping.lastSuccessAt ?? ''));

    return ranked[0] ?? null;
  }

  /**
   * Execute a real chat completion against a chosen candidate, with
   * automatic fallback on failure (§15, test J).
   */
  async complete({ messages, preferredModelId = null, maxTokens, timeoutMs = CONFIG.probeTimeoutMs, maxAttempts = 4, onEvent }) {
    const tried = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = await this.pick({
        preferredModelId,
        exclude: tried.map((t) => t.mapping.id),
      });
      if (!candidate) {
        return { ok: false, reason: 'NO_ELIGIBLE_MAPPING', tried };
      }

      const adapter = getAdapter(candidate.provider.protocol);
      const url = adapter.buildChatUrl(candidate.provider.baseURL);
      const startedAt = Date.now();

      onEvent?.({ stage: 'attempt', provider: candidate.provider.name, model: candidate.mapping.modelId });

      let response = null;
      let payload = null;
      let error = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        response = await fetch(url, {
          method: 'POST',
          headers: adapter.buildAuthHeaders(candidate.key.secret),
          body: JSON.stringify({
            model: candidate.mapping.modelId,
            messages,
            max_tokens: maxTokens ?? 256,
            stream: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        payload = await response.json().catch(() => null);
      } catch (e) {
        error = e;
      }

      const latencyMs = Date.now() - startedAt;
      const classification = response
        ? adapter.classifyResponse({ httpStatus: response.status, payload, headers: response.headers })
        : adapter.classifyResponse({ httpStatus: null, payload: error?.message });

      if (response?.ok && !payload?.error) {
        const content = payload?.choices?.[0]?.message?.content ?? null;
        const updated = await this._recordSuccess(candidate, latencyMs);
        onEvent?.({ stage: 'success', provider: candidate.provider.name, model: candidate.mapping.modelId, latencyMs });
        return { ok: true, content, latencyMs, candidate: updated, tried };
      }

      const updated = await this._recordFailure(candidate, classification, latencyMs);
      tried.push({ ...candidate, mapping: updated });

      // A malformed request will fail identically on every candidate, so
      // stop instead of burning the whole key pool (§35, test K).
      if (classification.status === STATUS.REQUEST_ERROR) {
        onEvent?.({ stage: 'abort', reason: 'REQUEST_ERROR' });
        return { ok: false, reason: 'REQUEST_ERROR', classification, tried };
      }

      onEvent?.({ stage: 'failed', provider: candidate.provider.name, status: classification.status });
    }

    return { ok: false, reason: 'EXHAUSTED', tried };
  }

  async _recordSuccess(candidate, latencyMs) {
    const mapping = await this.registry.updateMapping(candidate.mapping.id, {
      status: STATUS.HEALTHY,
      verified: true,
      failureCount: 0,
      cooldownUntil: null,
      latencyMs,
      lastSuccessAt: new Date().toISOString(),
      lastTestAt: new Date().toISOString(),
      lastErrorClass: null,
      lastErrorMessage: null,
    });
    await this.registry.setKeyStatus(candidate.key.id, STATUS.HEALTHY, {
      lastSuccessAt: new Date().toISOString(),
    });
    await this._clearBreaker(candidate.provider);
    await this.registry.logEvent({
      kind: 'route',
      provider: candidate.provider.name,
      model: candidate.mapping.modelId,
      fingerprint: candidate.key.fingerprint,
      maskedKey: candidate.key.masked,
      httpStatus: 200,
      classification: STATUS.HEALTHY,
      latencyMs,
    });
    return { ...candidate, mapping };
  }

  async _recordFailure(candidate, classification, latencyMs) {
    const { applyFailure } = await import('./health.js');
    const next = applyFailure(candidate.mapping, classification);
    const mapping = await this.registry.updateMapping(candidate.mapping.id, {
      status: next.status,
      verified: next.verified,
      failureCount: next.failureCount,
      cooldownUntil: next.cooldownUntil,
      score: next.score,
      latencyMs,
      lastFailureAt: next.lastFailureAt,
      lastTestAt: next.lastTestAt,
      lastErrorClass: next.lastErrorClass,
      lastErrorMessage: next.lastErrorMessage,
    });

    // Key-level status only for key-scoped problems (§13).
    if (classification.scope === 'key' && candidate.key) {
      await this.registry.setKeyStatus(candidate.key.id, classification.status, {
        lastFailureAt: new Date().toISOString(),
      });
    }
    // Provider-level failure feeds the circuit breaker (§18).
    if (classification.scope === 'provider' && candidate.provider) {
      await this._tripBreaker(candidate.provider, classification);
    }

    await this.registry.logEvent({
      kind: 'route',
      provider: candidate.provider.name,
      model: candidate.mapping.modelId,
      fingerprint: candidate.key.fingerprint,
      maskedKey: candidate.key.masked,
      httpStatus: classification.httpStatus ?? null,
      classification: classification.status,
      latencyMs,
      error: classification.message ?? null,
    });

    return mapping;
  }

  async _tripBreaker(provider, classification) {
    const { recordProviderFailure } = await import('./health.js');
    const breaker = recordProviderFailure(provider.breaker);
    await this.registry.storage.put('providers', {
      ...provider,
      breaker,
      updatedAt: new Date().toISOString(),
    });
    void classification;
  }

  async _clearBreaker(provider) {
    const { initialBreaker } = await import('./health.js');
    if (!provider.breaker || provider.breaker.state !== 'CLOSED') {
      await this.registry.storage.put('providers', {
        ...provider,
        breaker: initialBreaker(),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
