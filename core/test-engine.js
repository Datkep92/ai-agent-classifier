import { CONFIG } from './config.js';
import { STATUS } from './statuses.js';
import { discoverProvider } from './discovery.js';
import { probeMapping } from './probe.js';
import { applyFailure, applySuccess, computeScore, rescoreAll } from './health.js';
import { mapWithConcurrency, sleep, sanitizeError } from './util.js';
import { getAdapter } from './adapters/openai-compatible.js';

/**
 * Test Engine (§20).
 *
 * Pipeline: Connectivity -> Discovery -> Authentication -> Inference
 *           -> Latency -> Classification -> Registry update
 *
 * Actions: TEST KEY | TEST MODEL | TEST PROVIDER | TEST FAILED | TEST HEALTHY
 *          | TEST ALL
 *
 * Guarantees: bounded concurrency, progress callback, cancellation, no
 * unbounded retries, minimal tokens.
 */

export class TestEngine {
  constructor(registry, { router } = {}) {
    this.registry = registry;
    this._router = router ?? null;
  }

  get router() {
    return this._router;
  }

  setRouter(router) {
    this._router = router;
  }

  /** Cancel handle so the UI can abort a long TEST ALL. */
  createRun() {
    const controller = new AbortController();
    return {
      controller,
      cancelled: () => controller.signal.aborted,
      cancel: () => controller.abort(),
    };
  }

  // ------------------------------------------------------------- TEST PROVIDER

  async testProvider({ providerId, run, onProgress }) {
    const provider = await this.registry.getProvider(providerId);
    if (!provider) return { providerId, ok: false, reason: 'provider not found' };

    onProgress?.({ stage: 'connectivity', provider: provider.name });

    // 1. Discovery (also proves authentication when it passes).
    const firstKey = (await this.registry.listKeys(providerId))[0] ?? null;
    const discovery = await discoverProvider({
      registry: this.registry,
      provider,
      key: firstKey,
      onProgress,
    });

    if (run?.cancelled()) return { providerId, ok: false, cancelled: true };

    if (!discovery.ok) {
      // §10: /models failing does NOT kill the key. If we already know models
      // for this provider, go straight to inference probes.
      const knownModels = await this.registry.listModels(providerId);
      if (knownModels.length === 0) {
        await this.registry.setProviderStatus(providerId, provider.status);
        return {
          providerId,
          ok: false,
          stage: 'discovery',
          classification: discovery.classification,
          inferenceAttempted: false,
        };
      }
    }

    // 2. Authentication + Inference for each known model.
    const keys = await this.registry.listKeys(providerId);
    const models = await this.registry.listModels(providerId);
    if (keys.length === 0 || models.length === 0) {
      return { providerId, ok: false, stage: 'mapping', reason: 'no keys or models' };
    }

    const work = [];
    for (const model of models) {
      for (const key of keys) {
        work.push({ model, key });
      }
    }

    const summary = { pass: 0, fail: 0, results: [] };

    await mapWithConcurrency(
      work,
      CONFIG.testConcurrency,
      async ({ model, key }) => {
        if (run?.cancelled()) return;

        const { mapping } = await this.registry.upsertMapping({
          providerId,
          modelId: model.modelId,
          keyId: key.id,
        });

        onProgress?.({
          stage: 'inference',
          provider: provider.name,
          model: model.modelId,
          maskedKey: key.masked,
        });

        const result = await probeMapping({
          registry: this.registry,
          mapping,
          provider,
          model,
          key,
        });

        if (result.ok) summary.pass += 1;
        else summary.fail += 1;
        summary.results.push({
          modelId: model.modelId,
          keyId: key.id,
          ok: result.ok,
          status: result.classification.status,
          latencyMs: result.latencyMs,
        });

        onProgress?.({
          stage: 'inference-done',
          provider: provider.name,
          model: model.modelId,
          ok: result.ok,
          status: result.classification.status,
          latencyMs: result.latencyMs,
        });

        if (CONFIG.testDelayMs) await sleep(CONFIG.testDelayMs);
      }
    );

    const providerStatus = await this._recomputeProviderStatus(providerId);
    await rescoreAll(this.registry);

    return {
      providerId,
      ok: summary.pass > 0,
      discovery: discovery.ok,
      ...summary,
      providerStatus,
      cancelled: run?.cancelled() ?? false,
    };
  }

  // ------------------------------------------------------------------ TEST KEY

  async testKey({ keyId, run, onProgress }) {
    const key = await this.registry.getKey(keyId);
    if (!key) return { keyId, ok: false, reason: 'key not found' };

    const providers = (await this.registry.listProviders()).filter(
      (p) => p.id === key.providerId
    );
    const results = [];
    for (const provider of providers) {
      if (run?.cancelled()) break;
      const result = await this.testProvider({
        providerId: provider.id,
        run,
        onProgress: (e) => onProgress?.({ ...e, keyId }),
      });
      results.push(result);
    }
    return { keyId, ok: results.some((r) => r.ok), results };
  }

  // ---------------------------------------------------------------- TEST MODEL

  async testModel({ modelId, run, onProgress }) {
    const models = (await this.registry.listModels()).filter((m) => m.modelId === modelId);
    const results = [];
    for (const model of models) {
      if (run?.cancelled()) break;
      const result = await this.testProvider({
        providerId: model.providerId,
        run,
        onProgress: (e) => onProgress?.({ ...e, modelId }),
      });
      results.push(result);
    }
    return { modelId, ok: results.some((r) => r.ok), results };
  }

  // ----------------------------------------------------------------- TEST ALL

  /**
   * Build the quick-test target list: mappings whose model the user marked as
   * in use, or that have never been tested at all. Covers what matters
   * without spending a probe on every model a provider happens to advertise.
   */
  async quickTargets() {
    const [models, mappings] = await Promise.all([
      this.registry.listModels(),
      this.registry.listMappings(),
    ]);
    const favourite = new Set(
      models.filter((m) => m.capabilities?.favourite).map((m) => `${m.providerId}::${m.modelId}`)
    );
    return mappings.filter((m) => {
      const key = `${m.providerId}::${m.modelId}`;
      return favourite.has(key) || !m.lastTestAt;
    });
  }

  async testAll({ filter = 'all', run, onProgress, ensureMappings = true } = {}) {
    let synthesised = 0;

    // Make sure every provider/model/key combination that SHOULD exist has a
    // mapping before testing. Without this a provider imported without keys
    // yields zero mappings and TEST ALL silently does nothing.
    if (ensureMappings) synthesised = await this.ensureMappings();

    let target;
    if (filter === 'quick') {
      target = await this.quickTargets();
    } else {
      const mappings = await this.registry.listMappings();
      target = filter === 'all' ? mappings : mappings.filter((m) => m.status === filter);
    }

    const providers = await this.registry.listProviders();
    const keys = await this.registry.listKeys();
    const models = await this.registry.listModels();
    const providerById = new Map(providers.map((p) => [p.id, p]));
    const keyById = new Map(keys.map((k) => [k.id, k]));
    const modelByKey = new Map(models.map((m) => [`${m.providerId}::${m.modelId}`, m]));

    const summary = { pass: 0, fail: 0, skipped: 0, orphaned: 0, results: [] };

    await mapWithConcurrency(
      target,
      CONFIG.testConcurrency,
      async (mapping) => {
        if (run?.cancelled()) {
          summary.skipped += 1;
          return;
        }

        const provider = providerById.get(mapping.providerId);
        const key = keyById.get(mapping.keyId);
        const model = modelByKey.get(`${mapping.providerId}::${mapping.modelId}`);
        if (!provider || !key || !model) {
          // A mapping referencing a missing provider/key/model cannot be
          // tested. Counted separately from skipped so the UI can surface
          // it instead of hiding data-integrity problems.
          summary.orphaned += 1;
          summary.results.push({
            mappingId: mapping.id,
            providerId: mapping.providerId,
            modelId: mapping.modelId,
            ok: false,
            status: STATUS.UNRESOLVED,
            error: 'orphaned mapping: missing ' +
              [!provider && 'provider', !key && 'key', !model && 'model'].filter(Boolean).join('/'),
          });
          return;
        }

        onProgress?.({
          stage: 'inference',
          provider: provider.name,
          model: mapping.modelId,
          maskedKey: key.masked,
        });

        const result = await probeMapping({
          registry: this.registry,
          mapping,
          provider,
          model,
          key,
        });

        if (result.ok) summary.pass += 1;
        else summary.fail += 1;
        summary.results.push({
          mappingId: mapping.id,
          providerId: provider.id,
          modelId: mapping.modelId,
          ok: result.ok,
          status: result.classification.status,
          latencyMs: result.latencyMs,
          error: result.ok ? null : sanitizeError(result.classification.message ?? '', [key.secret]),
        });

        onProgress?.({
          stage: 'inference-done',
          provider: provider.name,
          model: mapping.modelId,
          ok: result.ok,
          status: result.classification.status,
          latencyMs: result.latencyMs,
        });
      },
      onProgress
    );

    for (const provider of providers) {
      await this._recomputeProviderStatus(provider.id);
    }
    await rescoreAll(this.registry);

    return { ...summary, synthesised, cancelled: run?.cancelled() ?? false };
  }

  /**
   * Create any missing Key x Model mapping. A mapping is the unit that health,
   * cooldown and rotation act on (plan 3), so a key/model pair with no mapping
   * is invisible to every other subsystem.
   */
  async ensureMappings() {
    const [providers, keys, models, existing] = await Promise.all([
      this.registry.listProviders(),
      this.registry.listKeys(),
      this.registry.listModels(),
      this.registry.listMappings(),
    ]);

    const have = new Set(existing.map((m) => `${m.providerId}::${m.modelId}::${m.keyId}`));
    let created = 0;

    for (const provider of providers) {
      const providerKeys = keys.filter((k) => k.providerId === provider.id && k.enabled !== false);
      const providerModels = models.filter((m) => m.providerId === provider.id);
      if (!providerKeys.length || !providerModels.length) continue;

      for (const model of providerModels) {
        // Skip a model this provider already refused. Re-creating the same
        // mapping every run is how a rejected pair gets re-probed for ever.
        if (!(await this.registry.shouldProbeModel(provider.identity, model.modelId))) continue;

        for (const key of providerKeys) {
          const identity = `${provider.id}::${model.modelId}::${key.id}`;
          if (have.has(identity)) continue;
          await this.registry.upsertMapping({
            providerId: provider.id,
            modelId: model.modelId,
            keyId: key.id,
            status: STATUS.UNRESOLVED,
          });
          have.add(identity);
          created += 1;
        }
      }
    }

    return created;
  }

  /** Recompute and persist a provider's aggregate status. */
  async _recomputeProviderStatus(providerId) {
    const mappings = await this.registry.listMappings({ providerId });
    const keys = await this.registry.listKeys(providerId);
    const statuses = [
      ...mappings.map((m) => m.status),
      ...keys.map((k) => k.status),
    ].filter((s) => s && s !== STATUS.UNRESOLVED);

    let status = STATUS.UNRESOLVED;
    if (statuses.includes(STATUS.HEALTHY)) status = STATUS.HEALTHY;
    else if (statuses.length) status = statuses[0];

    // Keep discovery signal if nothing was testable yet.
    if (status === STATUS.UNRESOLVED) status = STATUS.DISCOVERED;

    await this.registry.setProviderStatus(providerId, status);
    return status;
  }
}

export { applyFailure, applySuccess, computeScore };
