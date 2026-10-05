import { ingest, groupItems } from './ingest.js';
import { ITEM_TYPE, providerHintFromModel } from './classifier.js';
import { STATUS } from './statuses.js';
import { discoverProvider } from './discovery.js';
import { probeMapping } from './probe.js';
import { mapKeyToProvider, resolveUnresolved, probeModelWithoutKey } from './mapper.js';
import { baseUrlCandidates } from './normalizer.js';
import { CONFIG } from './config.js';
import { getAdapter } from './adapters/openai-compatible.js';

/**
 * Import pipeline: paste -> classify -> normalize -> dedupe -> discovery
 * -> probe -> auto-map -> registry.
 *
 * Order of paste must NOT matter (§5). The pipeline therefore:
 *   1. ingests and classifies everything,
 *   2. materializes providers/models/keys,
 *   3. attaches models to providers (evidence permitting),
 *   4. runs discovery + probes,
 *   5. parks anything still unmapped in Unresolved (§3, §23).
 */

/** Create providers from URLs, trying /models to verify OpenAI-compatibility (§7, N). */
async function ensureProvider({ registry, url, providerHint, adapter, onProgress }) {
  const { provider, created } = await registry.upsertProvider({ baseURL: url, name: providerHint ?? undefined });
  return { provider, created, adapter };
}

/**
 * Import one pasted blob. Returns a report the UI can render.
 */
export async function importPaste({
  registry,
  raw,
  probe = true,
  run,
  onProgress = () => {},
} = {}) {
  const items = ingest(raw);
  const groups = groupItems(items);

  const report = {
    ingested: items.length,
    providers: [],
    models: [],
    keys: [],
    mappings: [],
    unresolved: [],
    errors: [],
    cancelled: false,
  };

  if (!items.length) {
    // Preserve the raw input rather than dropping it (plan 3, 35).
    const { item } = await registry.addUnresolved({
      raw: String(raw ?? '').trim(),
      detectedType: 'UNKNOWN',
      candidates: [],
      meta: { reason: 'nothing classifiable in input' },
    });
    report.unresolved.push(item);
    report.errors.push('Nothing to import: input was empty or unparseable.');
    return report;
  }

  // Input we cannot classify is parked, never discarded (plan 3, 35).
  // When nothing at all was recognised we keep the original text verbatim as
  // a single item; otherwise each unrecognised token is kept on its own so a
  // stray token does not hide the useful parts of a mixed paste.
  const recognised = items.filter((i) => i.type !== 'UNKNOWN').length;

  if (items.length > 0 && recognised === 0) {
    const { item } = await registry.addUnresolved({
      raw: String(raw).trim(),
      detectedType: 'UNKNOWN_TEXT',
      candidates: [],
      meta: { reason: 'no token was classifiable; original text kept verbatim', tokens: items.length },
    });
    report.unresolved.push(item);
  } else {
    for (const unknown of groups.unknown) {
      const { item } = await registry.addUnresolved({
        raw: unknown.value,
        detectedType: 'UNKNOWN',
        candidates: [],
        meta: { reason: unknown.reason, confidence: unknown.confidence },
      });
      report.unresolved.push(item);
    }
  }

  // ---------------------------------------------------------------- providers
  const providersByHint = new Map();

  for (const item of groups.urls) {
    const { provider, created } = await ensureProvider({
      registry,
      url: item.value,
      providerHint: item.providerHint,
    });
    if (created) report.providers.push(provider.name);
    providersByHint.set(provider.id, provider);
    onProgress({ stage: 'provider', provider: provider.name, created });
  }

  // Pasting a model before any provider: park it in Unresolved (§7 test B).
  if (groups.models.length && providersByHint.size === 0) {
    for (const model of groups.models) {
      const { item } = await registry.addUnresolved({
        raw: model.value,
        detectedType: ITEM_TYPE.MODEL,
        candidates: [],
        meta: { reason: 'no provider yet', source: model.reason },
      });
      report.unresolved.push(item);
    }
  }

  // ------------------------------------------------------------------- models
  for (const model of groups.models) {
    if (providersByHint.size === 0) continue;
    for (const provider of providersByHint.values()) {
      const { model: stored, created } = await registry.upsertModel({
        providerId: provider.id,
        modelId: model.value,
        source: 'pasted',
      });
      if (created) report.models.push(`${provider.name}/${stored.modelId}`);
    }
  }

  // --------------------------------------------------------------------- keys
  for (const keyItem of groups.keys) {
    if (providersByHint.size === 0) {
      const { item } = await registry.addUnresolved({
        raw: keyItem.value,
        detectedType: ITEM_TYPE.API_KEY,
        candidates: keyItem.providerHint ? [keyItem.providerHint] : [],
        meta: { reason: 'no provider yet', hint: keyItem.providerHint },
      });
      report.unresolved.push(item);
      continue;
    }
    for (const provider of providersByHint.values()) {
      const { key, created } = await registry.upsertKey({
        providerId: provider.id,
        secret: keyItem.value,
      });
      if (created) report.keys.push({ provider: provider.name, masked: key.masked });
      providersByHint.set(provider.id, provider);
      // remember key per provider for the mapping stage
      provider._pendingKeys ??= [];
      provider._pendingKeys.push(key);
    }
  }

  // ------------------------------------------------------- discovery + mapping
  for (const provider of providersByHint.values()) {
    if (run?.cancelled()) {
      report.cancelled = true;
      break;
    }

    const keys = provider._pendingKeys ?? (await registry.listKeys(provider.id));
    const primaryKey = keys[0] ?? null;

    const discovery = await discoverProvider({
      registry,
      provider,
      key: primaryKey,
      onProgress,
    });
    if (run?.cancelled()) {
      report.cancelled = true;
      break;
    }

    // Models discovered now can resolve previously-pasted unknowns.
    const freshProvider = (await registry.getProvider(provider.id)) ?? provider;
    const knownModels = await registry.listModels(provider.id);

    for (const key of keys) {
      const mappings = await mapKeyToProvider({
        registry,
        provider: freshProvider,
        key,
        probe: probe ? (args) => probeMapping(args) : null,
        modelIds: knownModels.map((m) => m.modelId),
      });
      report.mappings.push(...mappings);
    }

    // No key yet: a Key x Model mapping cannot exist, but we can still prove
    // which models genuinely answer. Without this the tree lists models that
    // were never tested and TEST ALL has nothing to run.
    if (keys.length === 0 && probe && knownModels.length > 0) {
      for (const model of knownModels) {
        onProgress({
          stage: 'inference',
          provider: freshProvider.name,
          model: model.modelId,
        });

        const result = await probeModelWithoutKey({
          registry,
          provider: freshProvider,
          model,
        });

        await registry.storage.put('models', {
          ...model,
          anonymousProbe: {
            status: result.ok ? STATUS.HEALTHY : result.status,
            latencyMs: result.latencyMs,
            needsKey: result.needsKey,
            testedAt: new Date().toISOString(),
          },
          status: result.ok ? STATUS.HEALTHY : result.status,
          updatedAt: new Date().toISOString(),
        });

        report.anonymousProbes = (report.anonymousProbes ?? 0) + 1;
        if (result.ok) report.workingModels = (report.workingModels ?? 0) + 1;

        onProgress({
          stage: 'inference-done',
          provider: freshProvider.name,
          model: model.modelId,
          ok: result.ok,
          status: result.ok ? STATUS.HEALTHY : result.status,
          latencyMs: result.latencyMs,
        });
      }
    }
  }

  // ---------------------------------------------------------- unresolved sweep
  const resolution = await resolveUnresolved({
    registry,
    probe: probe ? (args) => probeMapping(args) : null,
    log: (m) => report.errors.push(m),
  });
  report.resolvedCount = resolution.resolved.length;

  // Anything still unmapped stays in the inbox — never dropped (§3).
  for (const item of await registry.listUnresolved()) {
    if (!report.unresolved.some((u) => u.id === item.id)) report.unresolved.push(item);
  }

  report.providersCount = (await registry.listProviders()).length;
  report.mappingsCount = (await registry.listMappings()).length;

  return report;
}

/**
 * TEST-ALL-friendly helper: probe every existing mapping (§20).
 */
export async function probeEverything({ registry, run, onProgress }) {
  const { TestEngine } = await import('./test-engine.js');
  const engine = new TestEngine(registry);
  return engine.testAll({ filter: 'all', run, onProgress });
}

export { baseUrlCandidates, getAdapter, CONFIG, STATUS };
