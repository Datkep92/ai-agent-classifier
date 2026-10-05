import { CONFIG } from './config.js';
import { STATUS } from './statuses.js';
import { modelsLooselyMatch } from './normalizer.js';

/**
 * Auto-map (§24).
 *
 * Evidence hierarchy — probe(inference) > discovery > heuristic:
 *   Inference PASS             100
 *   Authenticated /models PASS  70
 *   Model found in provider      60
 *   Known exact provider config  50
 *   Key prefix hint              20
 *   Name similarity              10
 *
 * A LOW-confidence heuristic is never promoted to VERIFIED (§35). Mapping is
 * created only on real evidence; ambiguous ties stay Unresolved (§23).
 */

export const EVIDENCE = CONFIG.evidence;
const EXACT = EVIDENCE.modelFoundInProvider;

/** Resolve a pasted model id against what a provider actually serves. */
export async function resolveModel({ registry, provider, modelId }) {
  const models = await registry.listModels(provider.id);

  const exact = models.find((m) => m.modelId === modelId);
  if (exact) {
    return { resolved: true, model: exact, evidence: EXACT, reason: 'exact model id found in provider' };
  }

  const loose = models.find((m) => modelsLooselyMatch(m.modelId, modelId));
  if (loose) {
    return {
      resolved: true,
      model: loose,
      evidence: EVIDENCE.nameSimilarity,
      reason: 'loose name similarity — requires probe to confirm',
      weak: true,
    };
  }

  // Not listed does not mean unusable. Keep it probe-able rather than
  // discarding it (§3, §7).
  return { resolved: false, model: null, evidence: 0, reason: 'model not listed by provider' };
}

/** Attach a key to a provider's models and optionally probe each mapping. */
export async function mapKeyToProvider({
  registry,
  provider,
  key,
  probe,
  modelIds = null,
  maxModels = 12,
}) {
  const models = modelIds
    ? modelIds.map((modelId) => ({ modelId }))
    : await registry.listModels(provider.id);

  const results = [];
  for (const model of models.slice(0, maxModels)) {
    const { mapping } = await registry.upsertMapping({
      providerId: provider.id,
      modelId: model.modelId,
      keyId: key.id,
      status: STATUS.UNRESOLVED,
    });

    if (!probe) {
      results.push({ mapping });
      continue;
    }

    const stored = (await registry.findModel(provider.id, model.modelId)) ?? {
      modelId: model.modelId,
    };
    results.push(await probe({ registry, mapping, provider, model: stored, key }));
  }

  return results;
}

/**
 * Resolve Unresolved inbox items against current registry data (§23).
 * Runs whenever new registry data arrives.
 */
export async function resolveUnresolved({ registry, probe, log }) {
  const items = await registry.listUnresolved();
  const providers = await registry.listProviders();
  const resolved = [];
  const kept = [];

  for (const item of items) {
    if (item.detectedType !== 'MODEL') {
      kept.push(item);
      continue;
    }

    const hits = [];
    for (const provider of providers) {
      const models = await registry.listModels(provider.id);
      const exact = models.find((m) => m.modelId === item.raw);
      const loose = exact ?? models.find((m) => modelsLooselyMatch(m.modelId, item.raw));
      if (!loose) continue;
      hits.push({ provider, model: loose, strength: exact ? EXACT : EVIDENCE.nameSimilarity });
    }

    if (hits.length === 0) {
      kept.push(item);
      continue;
    }

    hits.sort((a, b) => b.strength - a.strength);
    const top = hits[0];
    const tied = hits.length > 1 && hits[1].strength === top.strength;

    // A tie on weak evidence stays unresolved — never guess (§23, §35).
    if (tied && top.strength !== EXACT) {
      kept.push({
        ...item,
        candidates: hits.map((h) => `${h.provider.name}/${h.model.modelId}`),
      });
      log?.(`tie for model "${item.raw}" — keeping unresolved`);
      continue;
    }

    const { model } = await registry.upsertModel({
      providerId: top.provider.id,
      modelId: top.model.modelId,
      source: 'pasted',
    });

    for (const key of await registry.listKeys(top.provider.id)) {
      const { mapping } = await registry.upsertMapping({
        providerId: top.provider.id,
        modelId: model.modelId,
        keyId: key.id,
        status: STATUS.UNRESOLVED,
      });
      if (probe) {
        resolved.push(await probe({ registry, mapping, provider: top.provider, model, key }));
      }
    }

    await registry.removeUnresolved(item.id);
    resolved.push({ raw: item.raw, provider: top.provider.name, model: model.modelId });
  }

  return { resolved, kept };
}
