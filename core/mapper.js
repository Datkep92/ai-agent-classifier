import { CONFIG } from './config.js';
import { STATUS } from './statuses.js';
import { modelsLooselyMatch } from './normalizer.js';
import { getAdapter } from './adapters/openai-compatible.js';

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

/**
 * Verify a model without any key (plan 7, 10).
 *
 * A provider discovered via an unauthenticated /models proves the endpoint
 * exists but says nothing about whether a specific model actually runs.
 * Many gateways answer inference without a key (open free tier) or with a
 * placeholder, so we send the real production-shaped probe and record
 * whether the model genuinely answers. This is what fills the tree with
 * "model known to work" instead of "model merely listed".
 */
export async function probeModelWithoutKey({ registry, provider, model, timeoutMs }) {
  const adapter = getAdapter(provider.protocol);
  const result = await adapter.probeModel({
    baseURL: provider.baseURL,
    secret: null,
    model: model.modelId,
    timeoutMs: timeoutMs ?? CONFIG.probeTimeoutMs,
  });

  const classification = result.classification ?? { status: STATUS.UNKNOWN_ERROR };
  await registry.logEvent({
    kind: 'probe-anonymous',
    provider: provider.name,
    model: model.modelId,
    httpStatus: result.httpStatus ?? null,
    classification: classification.status,
    latencyMs: result.latencyMs ?? null,
  });

  return {
    ok: result.ok,
    status: classification.status,
    latencyMs: result.latencyMs ?? null,
    // AUTH_INVALID without a key means the endpoint requires a key. That is
    // still useful: the model is real, we just cannot verify it yet.
    needsKey: !result.ok && classification.status === STATUS.AUTH_INVALID,
  };
}

/** Attach a key to a provider's models and optionally probe each mapping. */
export async function mapKeyToProvider({
  registry,
  provider,
  key,
  probe,
  modelIds = null,
  // Caps automatic probing at import time so pasting a URL for a provider
  // with hundreds of models stays cheap. Pass Infinity when the user is
  // deliberately scanning, where completeness matters more than tokens.
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
 * Try a model that no provider advertises by probing it directly.
 * Only a real inference PASS resolves the item (plan 7, 24).
 *
 * Delegates to syncPastedModelsToProviders so speculative attaches have exactly
 * one implementation. Two copies of this logic had already drifted apart: the
 * rollback that removes a disproved guess was missing here, which let a failed
 * guess land in the tree anyway.
 */
async function probeUnknownModel({ registry, item, providers, probe, log }) {
  return syncPastedModelsToProviders({ registry, item, providers, probe, log });
}

/**
 * Attach one parked MODEL to a provider that can actually serve it (plan 7).
 *
 * The forward direction (provider exists -> find matching parked model) is
 * handled by the MODEL branch of resolveUnresolved below. This handles the
 * case where NOTHING matches: the user named a model no /models response
 * mentions. Not being advertised is not proof of being unusable, but
 * attaching it on that hunch alone is exactly the "model assigned to the wrong
 * provider" bug.
 *
 * So a speculative attach is committed only on evidence:
 *   - a key exists and a real inference probe PASSES,
 *   - no key exists but an unauthenticated probe PASSES (open gateways), or
 *   - probing is switched off entirely (import without probe), where the row
 *     is attached but stays UNRESOLVED rather than being called healthy.
 * A provider that disproves the model leaves the item parked rather than
 * guessed into whichever provider happens to exist.
 *
 * Every attempt is recorded on the item so a model that fails everywhere shows
 * the user exactly what was tried.
 */
async function syncPastedModelsToProviders({ registry, item, providers, probe, log }) {
  if (!providers.length) return { attached: 0 };

  const tried = [];

  for (const provider of providers) {
    // Already refused here once. Trying again burns a request to re-learn a
    // fact we are certain of.
    if (provider.identity && !(await registry.shouldProbeModel(provider.identity, item.raw))) {
      tried.push({ provider: provider.name, result: 'ALREADY_REJECTED' });
      continue;
    }

    const keys = (await registry.listKeys(provider.id)).filter((k) => k.enabled !== false);

    // No key is not a dead end: an unauthenticated probe is real evidence too
    // (many gateways serve inference without one), and the pipeline already
    // relies on exactly that when it first discovers a keyless provider.
    if (!keys.length) {
      const { model } = await registry.upsertModel({
        providerId: provider.id,
        modelId: item.raw,
        source: 'pasted',
        capabilities: { favourite: true },
      });

      if (!probe) {
        tried.push({ provider: provider.name, result: 'ATTACHED_UNVERIFIED' });
        await registry.removeUnresolved(item.id);
        return { attached: 1 };
      }

      const anonymous = await probeModelWithoutKey({ registry, provider, model });
      if (anonymous.ok) {
        tried.push({ provider: provider.name, result: 'VERIFIED_ANONYMOUS' });
        await registry.removeUnresolved(item.id);
        log?.(`pasted model "${item.raw}" verified on ${provider.name} (no key needed)`);
        return { attached: 1 };
      }

      for (const mapping of await registry.listMappings(provider.id)) {
        if (mapping.modelId === model.modelId) await registry.storage.remove('mappings', mapping.id);
      }
      await registry.removeModel(provider.id, model.modelId);
      if (provider.identity) await registry.recordRejectedModel(provider.identity, item.raw);
      tried.push({ provider: provider.name, result: 'NOT_AVAILABLE' });
      continue;
    }

    const { model } = await registry.upsertModel({
      providerId: provider.id,
      modelId: item.raw,
      source: 'pasted',
      // A pasted model expresses intent, so it counts as in-use.
      capabilities: { favourite: true },
    });

    let anyPass = false;
    for (const key of keys) {
      const { mapping } = await registry.upsertMapping({
        providerId: provider.id,
        modelId: model.modelId,
        keyId: key.id,
        status: STATUS.UNRESOLVED,
      });
      if (!probe) continue;
      const result = await probe({ registry, mapping, provider, model, key });
      if (result.ok) anyPass = true;
    }

    if (!probe) {
      // Discovery-only mode: keep the row, but do not claim it works.
      tried.push({ provider: provider.name, result: 'ATTACHED_UNVERIFIED' });
      await registry.removeUnresolved(item.id);
      log?.(`pasted model "${item.raw}" attached to ${provider.name} (unverified)`);
      return { attached: 1 };
    }

    if (anyPass) {
      tried.push({ provider: provider.name, result: 'VERIFIED' });
      await registry.removeUnresolved(item.id);
      log?.(`pasted model "${item.raw}" verified on ${provider.name}`);
      return { attached: 1 };
    }

    // Probed and disproved here. Undo the speculative row and its mappings so
    // a failed guess cannot masquerade as one of the provider's real models.
    for (const mapping of await registry.listMappings(provider.id)) {
      if (mapping.modelId === model.modelId) await registry.storage.remove('mappings', mapping.id);
    }
    await registry.removeModel(provider.id, model.modelId);

    // Remember the refusal so later sweeps do not spend requests rediscovering
    // it. The user can undo this by mapping the model by hand.
    if (provider.identity) await registry.recordRejectedModel(provider.identity, item.raw);
    tried.push({ provider: provider.name, result: 'NOT_AVAILABLE' });
  }

  const updated = {
    ...item,
    candidates: tried,
    meta: { ...item.meta, reason: 'no provider confirmed this model yet' },
  };
  await registry.storage.put('unresolved', updated);
  log?.(
    `pasted model "${item.raw}" stayed unresolved: ` +
      tried.map((t) => `${t.provider}=${t.result}`).join(', ')
  );

  return { attached: 0 };
}

/**
 * Resolve Unresolved inbox items against current registry data (§23).
 * Runs whenever new registry data arrives.
 */
export async function resolveUnresolved({ registry, probe, log }) {
  // Providers are read fresh on every iteration: attaching a model to one
  // provider must not make it visible to a later parked item's candidate scan,
  // otherwise a disproved guess leaks back in through resolveModel below.
  for (const item of await registry.listUnresolved()) {
    if (item.detectedType !== 'MODEL') continue;
    await syncPastedModelsToProviders({ registry, item, providers: await registry.listProviders(), probe, log });
  }

  const items = await registry.listUnresolved();
  const resolved = [];
  const kept = [];
  // Re-read after the model pass: a provider created during this sweep must be
  // visible to the key/model branches below, not hidden by a stale snapshot.
  const providers = await registry.listProviders();

  for (const item of items) {
    if (item.detectedType === 'API_KEY') {
      // A key that arrived before its provider is parked here. Now that
      // providers exist, try the key against each one and keep only real
      // evidence (plan 7, 23): a key prefix hint alone never counts, and an
      // ambiguous result stays Unresolved rather than being guessed.
      const attempted = [];
      let verifiedAny = false;

      for (const provider of providers) {
        // A provider with no discovered models can still accept the key, so
        // we attempt discovery here regardless and record the verdict.
        const models = await registry.listModels(provider.id);

        // Cheap pre-check: discovery must authenticate before we spend
        // inference requests on every model.
        const modelsProbe = await getAdapter(provider.protocol).discoverModels({
          baseURL: provider.baseURL,
          secret: item.raw,
          timeoutMs: CONFIG.discoveryTimeoutMs,
        });

        if (!modelsProbe.ok) {
          attempted.push({
            provider: provider.name,
            result: modelsProbe.classification?.status ?? 'UNKNOWN',
          });
          // AUTH_INVALID / EXPIRED / QUOTA are key-scoped verdicts about
          // this secret, but a different provider may still accept it, so
          // we keep scanning rather than concluding here.
          continue;
        }

        const { key, blocked } = await registry.upsertKey({
          providerId: provider.id,
          secret: item.raw,
        });

        // The user deleted this secret from this provider before. Do not
        // resurrect it and do not claim it was accepted: keep scanning the
        // other providers, and leave the item parked if none take it.
        if (blocked) {
          attempted.push({ provider: provider.name, result: 'BLOCKED_BY_USER' });
          continue;
        }

        if (!models.length) {
          // Authenticated but advertises nothing: the key is valid and now
          // visible in the tree, but we cannot verify a model against it.
          // Keep scanning: another provider may both accept the key and
          // serve models, which is the more useful outcome.
          attempted.push({ provider: provider.name, result: 'AUTH_OK_NO_MODELS' });
          verifiedAny = true;
          continue;
        }

        const results = await mapKeyToProvider({
          registry,
          provider,
          key,
          probe: probe ? (args) => probe(args) : null,
          // Deliberate scan: cover every model, not the import-time subset.
          maxModels: Infinity,
        });

        const passed = results.some((r) => r.ok);
        attempted.push({ provider: provider.name, result: passed ? 'VERIFIED' : 'LISTED_ONLY' });

        // Do NOT stop at the first provider that accepts the key. A secret
        // pasted once may be valid on several gateways, and finding them all
        // is the point of scanning (plan 7, 15).
        if (passed) verifiedAny = true;
      }

      if (verifiedAny) {
        await registry.removeUnresolved(item.id);
        resolved.push({ raw: item.raw.slice(0, 8), type: 'API_KEY', verified: true });
      } else {
        // Replace the parked prefix hint with what we actually observed and
        // persist it, otherwise the UI keeps showing the original guess.
        const updated = {
          ...item,
          candidates: attempted.map((a) => `${a.provider}:${a.result}`),
          meta: { ...item.meta, reason: 'no provider accepted this key yet' },
        };
        await registry.storage.put('unresolved', updated);
        kept.push(updated);
        log?.('key could not be mapped: ' + attempted.map((a) => a.provider + '=' + a.result).join(', '));
      }
      continue;
    }

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
      // Not listed by /models, but that is not proof the model is unusable.
      // A provider may serve models it does not advertise, so we attempt a
      // real inference probe on each provider that has a key (plan 7).
      // Inference PASS is the strongest evidence in the system (plan 24);
      // anything weaker stays Unresolved rather than being guessed.
      const probed = await probeUnknownModel({ registry, item, providers, probe, log });
      if (probed.attached) {
        // The helper already removed the item and recorded what it tried.
        kept.push(item);
      } else {
        // It also already wrote the updated item (with candidates) to storage.
        // Re-reading keeps this branch from clobbering that record.
        kept.push((await registry.storage.get('unresolved', item.id)) ?? item);
      }
      continue;
    }

    hits.sort((a, b) => b.strength - a.strength);
    const top = hits[0];
    const tied = hits.length > 1 && hits[1].strength === top.strength;

    // A tie on weak evidence stays unresolved — never guess (§23, §35).
    if (tied && top.strength !== EXACT) {
      const updated = {
        ...item,
        candidates: hits.map((h) => `${h.provider.name}/${h.model.modelId}`),
      };
      await registry.storage.put('unresolved', updated);
      kept.push(updated);
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
