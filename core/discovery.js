import { getAdapter } from './adapters/openai-compatible.js';
import { baseUrlCandidates } from './normalizer.js';
import { STATUS } from './statuses.js';
import { CONFIG } from './config.js';

/**
 * Discovery (§10).
 *
 * Discovery and inference verification are TWO different things.
 *
 *   /models PASS  -> import model ids, mark DISCOVERED.
 *                    Do NOT conclude inference works.
 *   /models FAIL  -> do NOT mark the key DEAD (§35).
 *                    Keep it eligible for an inference probe.
 */

export async function discoverProvider({
  registry,
  provider,
  key,
  adapter,
  onProgress,
} = {}) {
  const protocolAdapter = adapter ?? getAdapter(provider.protocol);
  const secret = key?.secret ?? null;
  const tried = [];

  // Try the normalized base URL first, then the /v1 variant as a candidate.
  // We test candidates; we never assume (§8).
  const candidates = baseUrlCandidates(provider.baseURL);

  let best = null;
  for (const candidate of candidates) {
    onProgress?.({ stage: 'discovery', provider: provider.name, baseURL: candidate });
    const result = await protocolAdapter.discoverModels({
      baseURL: candidate,
      secret,
      timeoutMs: CONFIG.discoveryTimeoutMs,
    });
    tried.push({ baseURL: candidate, ok: result.ok, httpStatus: result.httpStatus ?? null });

    if (result.ok) {
      best = { baseURL: candidate, result };
      break;
    }
  }

  if (!best) {
    const last = tried[tried.length - 1];
    const classification = {
      status: STATUS.UNKNOWN_ERROR,
      scope: 'provider',
      httpStatus: last?.httpStatus ?? null,
      message: 'discovery failed for all base URL candidates',
    };
    await registry.setProviderStatus(provider.id, STATUS.DISCOVERED, {
      metadata: { ...provider.metadata, discoveryFailed: true, tried },
    });
    return { ok: false, models: [], tried, classification };
  }

  // Import discovered models.
  let imported = 0;
  for (const modelId of best.result.models) {
    const { model, created } = await registry.upsertModel({
      providerId: provider.id,
      modelId,
      source: 'discovered',
    });
    if (created) imported += 1;
    void model;
  }

  // A different base URL worked -> persist the winner.
  if (best.baseURL !== provider.baseURL) {
    await registry.storage.put('providers', {
      ...provider,
      baseURL: best.baseURL,
      updatedAt: new Date().toISOString(),
    });
  }

  await registry.setProviderStatus(provider.id, STATUS.DISCOVERED, {
    metadata: {
      ...provider.metadata,
      discovered: true,
      discoveryFailed: false,
      modelCount: best.result.models.length,
      tried,
    },
  });

  // Stamp a successful fetch. Startup sync uses this to skip a provider that
  // was just refreshed instead of re-downloading the list on every page load.
  // Only success stamps: a provider that failed stays eligible for a retry.
  await registry.storage.put('providers', {
    ...(await registry.getProvider(provider.id)),
    lastSyncedAt: new Date().toISOString(),
  });

  if (key) {
    // Discovery PASS is authentication evidence (70), but never "verified"
    // for inference. §10: do not conclude inference works.
    await registry.setKeyStatus(key.id, STATUS.DISCOVERED, {
      lastSuccessAt: new Date().toISOString(),
    });
  }

  await registry.logEvent({
    kind: 'discovery',
    provider: provider.name,
    fingerprint: key?.fingerprint ?? null,
    maskedKey: key?.masked ?? null,
    httpStatus: best.result.httpStatus,
    classification: STATUS.DISCOVERED,
    latencyMs: best.result.latencyMs,
  });

  return {
    ok: true,
    baseURL: best.baseURL,
    models: best.result.models,
    imported,
    latencyMs: best.result.latencyMs,
    tried,
  };
}
