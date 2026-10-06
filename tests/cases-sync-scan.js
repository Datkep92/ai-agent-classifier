import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { TestEngine } from '../core/test-engine.js';
import { importPaste, syncAllProviders } from '../core/pipeline.js';
import { resolveUnresolved } from '../core/mapper.js';
import { createMockFetch } from './mock-fetch.js';
import { CONFIG } from '../core/config.js';
import { STATUS } from '../core/statuses.js';

// Synthetic fixtures only. These strings are never valid credentials.
const KEY = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const PASTED_MODEL = 'fledge-alpha-free';

const OK_CHAT = { body: { choices: [{ message: { content: 'OK' } }] } };
const NO_MODELS_ROUTE = (ids) => ({ body: { data: ids.map((id) => ({ id })) } });

/**
 * Install per-test routes on a private mock fetch and point the app at it.
 *
 * The suite shares one mock, and a test that only overwrites '/models' inherits
 * whatever '/chat/completions' the previous test left behind. Building a fresh
 * table per test keeps every case hermetic instead of order-dependent.
 */
function useRoutes(routes) {
  const fetchMock = createMockFetch(routes);
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function modelNames(models) {
  return models.map((m) => m.modelId).sort();
}

function run() {
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    cancel: () => {
      cancelled = true;
    },
  };
}

export function registerSyncCases(mockFetch) {
  describe('P. Pasted model attaches to a URL (plan 7)', () => {
    it('P1: model pasted BEFORE the URL attaches, is starred, inbox clears', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());

      await importPaste({ registry, raw: PASTED_MODEL, onProgress: () => {} });
      assertEqual((await registry.listModels()).length, 0, 'nothing to attach to yet');
      assertEqual((await registry.listUnresolved()).length, 1, 'model parked, never dropped');

      await importPaste({
        registry,
        raw: 'https://opencode.ai/zen/v1',
        onProgress: () => {},
      });

      const models = await registry.listModels();
      assertEqual(
        JSON.stringify(modelNames(models)),
        JSON.stringify(['fledge-alpha-free', 'gpt-4o']),
        'pasted model joined the tree'
      );

      const pasted = models.find((m) => m.modelId === PASTED_MODEL);
      assertEqual(pasted.capabilities.favourite, true, 'a model the user named counts as in use');
      assertEqual(pasted.source, 'pasted', 'provenance recorded');
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox cleared');
    });

    it('P2: URL pasted first, then model - no duplicate row', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });
      await importPaste({ registry, raw: PASTED_MODEL, onProgress: () => {} });

      const models = await registry.listModels();
      const matching = models.filter((m) => m.modelId === PASTED_MODEL);
      assertEqual(matching.length, 1, 'exactly one row for the pasted model');
      assertEqual(matching[0].capabilities.favourite, true, 'still starred');
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox cleared');
    });

    it('P3: model both pasted and discovered keeps BOTH sources and the star', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE([PASTED_MODEL, 'gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: PASTED_MODEL, onProgress: () => {} });
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });

      const model = (await registry.listModels()).find((m) => m.modelId === PASTED_MODEL);
      assert(model, 'model row exists');
      assert(model.sources.includes('pasted'), 'pasted provenance kept: ' + model.sources);
      assert(model.sources.includes('discovered'), 'discovered provenance kept: ' + model.sources);
      assertEqual(model.capabilities.favourite, true, 'star survives rediscovery');
    });

    it('P4: a model no provider serves is NOT attached to a random provider', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': { status: 404, body: { error: { message: 'model not found' } } },
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY}`,
        onProgress: () => {},
      });
      // The key is rejected, so the provider holds no usable key: the model
      // can only be settled by a probe that comes back 404.
      await importPaste({ registry, raw: 'totally-unknown-model', onProgress: () => {} });

      const models = await registry.listModels();
      assert(
        !models.some((m) => m.modelId === 'totally-unknown-model'),
        'a disproved guess must not linger in the tree'
      );
      // The rejected key is parked too, so look the model up specifically.
      const parked = (await registry.listUnresolved()).find(
        (i) => i.detectedType === 'MODEL' && i.raw === 'totally-unknown-model'
      );
      assert(parked, 'stays parked so the user can see it');
      assert(
        parked.candidates.length > 0,
        'records what was tried: ' + JSON.stringify(parked.candidates)
      );
      // Either verdict is honest: NOT_AVAILABLE on the first sweep,
      // ALREADY_REJECTED once the refusal has been remembered and the sweep no
      // longer spends a request rediscovering it.
      assert(
        parked.candidates.some((c) => ['NOT_AVAILABLE', 'ALREADY_REJECTED'].includes(c.result)),
        'and says the provider refused it: ' + JSON.stringify(parked.candidates)
      );
      assert(
        await registry.isRememberedRejection('https://opencode.ai/zen/v1', 'totally-unknown-model'),
        'the refusal is remembered so it is not retried'
      );
    });

    it('P5: a failed attach leaves no orphan mappings behind', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': { status: 404, body: { error: { message: 'model not found' } } },
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY}`,
        onProgress: () => {},
      });
      await importPaste({ registry, raw: 'ghost-model-9000', onProgress: () => {} });

      const mappings = await registry.listMappings();
      assert(
        !mappings.some((m) => m.modelId === 'ghost-model-9000'),
        'speculative mapping rolled back with the row'
      );
    });

    it('P6: a keyless provider still counts as evidence when inference answers', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });
      assertEqual((await registry.listKeys()).length, 0, 'provider genuinely has no key');

      await importPaste({ registry, raw: 'free-open-model', onProgress: () => {} });

      const models = await registry.listModels();
      const hit = models.find((m) => m.modelId === 'free-open-model');
      assert(hit, 'an unauthenticated PASS is real evidence, so the model attaches');
      assertEqual(hit.capabilities.favourite, true, 'and is starred');
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox cleared');
    });

    it('P7: a keyless provider that refuses inference leaves the model parked', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': { status: 401, body: { error: { message: 'You must provide an API key' } } },
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });
      await importPaste({ registry, raw: 'locked-model', onProgress: () => {} });

      assert(
        !(await registry.listModels()).some((m) => m.modelId === 'locked-model'),
        'refused inference is not evidence, so nothing is attached'
      );
      const parked = await registry.listUnresolved();
      assert(
        parked.some((i) => i.detectedType === 'MODEL' && i.raw === 'locked-model'),
        'kept in the inbox for the user to resolve later'
      );
    });
  });
}

export function registerProviderSyncCases(mockFetch) {
  describe('S. Provider model sync (plan 21)', () => {
    it('S1: sync adds models the provider did not list before', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });
      assertEqual((await registry.listModels()).length, 1, 'one model known');

      // The provider adds a model after the initial import.
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o', 'new-model-x']),
        '/chat/completions': OK_CHAT,
      });

      const summary = await syncAllProviders({ registry, force: true });
      assertEqual(summary.providers, 1, 'provider refreshed');
      assertEqual(summary.modelsAdded, 1, 'exactly the newly listed model counted');
      assertEqual(
        JSON.stringify(modelNames(await registry.listModels())),
        JSON.stringify(['gpt-4o', 'new-model-x']),
        'merged'
      );
    });

    it('S2: sync skips a provider refreshed within the freshness window', async () => {
      const fetchMock = useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });

      const before = fetchMock.calls.filter((c) => c.url.includes('/models')).length;
      const summary = await syncAllProviders({ registry });
      const after = fetchMock.calls.filter((c) => c.url.includes('/models')).length;

      assertEqual(summary.skipped, 1, 'provider treated as fresh');
      assertEqual(after, before, 'no network call issued for a fresh provider');
    });

    it('S3: force refreshes even a fresh provider', async () => {
      const fetchMock = useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });

      const before = fetchMock.calls.filter((c) => c.url.includes('/models')).length;
      const summary = await syncAllProviders({ registry, force: true });
      const after = fetchMock.calls.filter((c) => c.url.includes('/models')).length;

      assertEqual(summary.skipped, 0, 'nothing skipped when forced');
      assert(after > before, 'the forced sync actually hit the network');
    });

    it('S4: sync never opens more than the configured concurrency', async () => {
      const registry = new Registry(new MemoryStorage());
      for (let i = 0; i < 10; i++) {
        await registry.upsertProvider({ baseURL: `https://p${i}.sync.test/v1` });
      }

      let inFlight = 0;
      let peak = 0;
      useRoutes({
        '/models': async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return NO_MODELS_ROUTE(['m1']);
        },
      });

      await syncAllProviders({ registry, force: true });
      assert(
        peak <= CONFIG.testConcurrency,
        `concurrency stayed bounded (peak ${peak} <= ${CONFIG.testConcurrency})`
      );
      assertEqual(peak > 1, true, 'and actually ran providers in parallel');
    });

    it('S5: one broken provider does not stop the others', async () => {
      const registry = new Registry(new MemoryStorage());
      await registry.upsertProvider({ baseURL: 'https://good-one.test/v1' });
      await registry.upsertProvider({ baseURL: 'https://broken.test/v1' });
      await registry.upsertProvider({ baseURL: 'https://good-two.test/v1' });

      useRoutes({
        'broken.test': { __throw: true, message: 'host unreachable' },
        '/models': NO_MODELS_ROUTE(['m1', 'm2']),
      });

      const summary = await syncAllProviders({ registry, force: true });
      assertEqual(summary.failed, 1, 'the broken host is counted as a failure');
      assertEqual(summary.providers, 2, 'both healthy providers still refreshed');

      const models = await registry.listModels();
      assert(models.some((m) => m.providerId && m.modelId === 'm1'), 'good hosts still imported');
    });

    it('S6: cancelling stops the sweep before it resolves parked items', async () => {
      const registry = new Registry(new MemoryStorage());
      await registry.upsertProvider({ baseURL: 'https://cancelme.test/v1' });
      await registry.addUnresolved({ raw: 'parked-model', detectedType: 'MODEL', candidates: [] });

      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const handle = run();
      handle.cancel();

      const summary = await syncAllProviders({ registry, force: true, run: handle });
      assertEqual(summary.cancelled, true, 'run reports it was cancelled');
      assertEqual((await registry.listUnresolved()).length, 1, 'parked item untouched');
    });

    it('S7: sync attaches a parked model that discovery can now prove', async () => {
      useRoutes({
        '/models': NO_MODELS_ROUTE(['gpt-4o']),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await registry.upsertProvider({ baseURL: 'https://opencode.ai/zen/v1' });
      await registry.upsertKey({
        providerId: (await registry.listProviders())[0].id,
        secret: KEY,
      });
      await registry.addUnresolved({ raw: PASTED_MODEL, detectedType: 'MODEL', candidates: [] });

      const summary = await syncAllProviders({ registry, force: true });
      assertEqual(summary.resolved, 1, 'the parked model resolved during sync');

      const models = await registry.listModels();
      const attached = models.find((m) => m.modelId === PASTED_MODEL);
      assert(attached, 'model is in the tree');
      assertEqual(attached.capabilities.favourite, true, 'and starred');
    });
  });

  describe('C. Deliberate key scan covers everything (plan 15)', () => {
    it('C1: a key accepted by the first provider is still tried on the second', async () => {
      const registry = new Registry(new MemoryStorage());
      const first = await registry.upsertProvider({ baseURL: 'https://first.test/v1' });
      const second = await registry.upsertProvider({ baseURL: 'https://second.test/v1' });
      await registry.upsertModel({ providerId: first.provider.id, modelId: 'gpt-4o' });
      await registry.upsertModel({ providerId: second.provider.id, modelId: 'gpt-4o' });
      await registry.addUnresolved({ raw: KEY, detectedType: 'API_KEY', candidates: [] });

      const seen = [];
      await resolveUnresolved({
        registry,
        probe: async ({ provider, key }) => {
          seen.push(provider.id);
          return { ok: true };
        },
      });

      assert(
        seen.includes(first.provider.id) && seen.includes(second.provider.id),
        'both providers probed, not just the first: ' + seen.join(',')
      );
      const keys = await registry.listKeys();
      assertEqual(keys.length, 2, 'the key is registered on every provider that accepts it');
    });

    it('C2: a key is scanned against ALL of a provider\'s models, not the first 12', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://big.test/v1' });

      const total = 30;
      for (let i = 0; i < total; i++) {
        await registry.upsertModel({ providerId: provider.id, modelId: `model-${i}` });
      }
      await registry.addUnresolved({ raw: KEY, detectedType: 'API_KEY', candidates: [] });

      const probed = new Set();
      await resolveUnresolved({
        registry,
        probe: async ({ model }) => {
          probed.add(model.modelId);
          return { ok: false };
        },
      });

      assertEqual(probed.size, total, `every model probed (${probed.size}/${total}), not a 12 cap`);
    });

    it('C3: import-time mapping still caps probing at 12 models', async () => {
      const fetchMock = useRoutes({
        '/models': NO_MODELS_ROUTE(Array.from({ length: 30 }, (_, i) => `model-${i}`)),
        '/chat/completions': OK_CHAT,
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://big.test/v1\n${KEY}`,
        onProgress: () => {},
      });

      const chatCalls = fetchMock.calls.filter((c) => c.url.includes('/chat/completions'));
      assertEqual(chatCalls.length, 12, 'pasting stays cheap: capped at 12 probes');
    });
  });
}

export function registerQuickTestCases(mockFetch) {
  describe('Q. Quick test targets (plan 20)', () => {
    it('Q1: quick targets are exactly the starred models plus never-tested mappings', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://quick.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-quick-fixture-1' });

      for (const id of ['starred', 'tested-plain', 'untested']) {
        await registry.upsertModel({ providerId: provider.id, modelId: id });
        await registry.upsertMapping({ providerId: provider.id, modelId: id, keyId: key.id });
      }
      await registry.setModelCapabilities(provider.id, 'starred', { favourite: true });
      await registry.storage.put(
        'mappings',
        Object.assign(await registry.storage.get(
          'mappings',
          (await registry.listMappings()).find((m) => m.modelId === 'tested-plain').id
        ), { lastTestAt: '2024-01-01T00:00:00.000Z' })
      );

      const engine = new TestEngine(registry);
      const targets = (await engine.quickTargets()).map((m) => m.modelId).sort();

      assertEqual(JSON.stringify(targets), JSON.stringify(['starred', 'untested']), 'only starred + never tested');
    });

    it('Q2: quick test runs against those targets and leaves the rest alone', async () => {
      useRoutes({ '/chat/completions': OK_CHAT });

      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://quick.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-quick-fixture-2' });

      for (const id of ['starred', 'boring']) {
        await registry.upsertModel({ providerId: provider.id, modelId: id });
        await registry.upsertMapping({ providerId: provider.id, modelId: id, keyId: key.id });
      }
      await registry.setModelCapabilities(provider.id, 'starred', { favourite: true });
      // Mark 'boring' as already tested so it is not a quick target.
      const boring = (await registry.listMappings()).find((m) => m.modelId === 'boring');
      await registry.updateMapping(boring.id, { lastTestAt: new Date().toISOString() });

      const engine = new TestEngine(registry);
      const summary = await engine.testAll({ filter: 'quick' });

      assertEqual(summary.results.length, 1, 'exactly one mapping probed');
      assertEqual(summary.results[0].modelId, 'starred', 'the starred one');
      assertEqual(summary.pass, 1, 'and it passed');
    });

    it('Q3: starring a model changes capabilities without touching sources', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://star.test/v1' });
      await registry.upsertModel({
        providerId: provider.id,
        modelId: 'discovered-model',
        source: 'discovered',
      });

      const starred = await registry.setModelCapabilities(provider.id, 'discovered-model', {
        favourite: true,
      });
      assertEqual(starred.capabilities.favourite, true, 'star applied');
      assertEqual(
        JSON.stringify(starred.sources),
        JSON.stringify(['discovered']),
        'a star is not a provenance event: ' + JSON.stringify(starred.sources)
      );
      assertEqual(starred.source, 'discovered', 'primary source unchanged');
    });

    it('Q4: later discovery never clears an existing star', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://star.test/v1' });
      await registry.upsertModel({
        providerId: provider.id,
        modelId: 'both-ways',
        source: 'pasted',
        capabilities: { favourite: true },
      });
      // Discovery rediscovers it, passing no capabilities.
      await registry.upsertModel({
        providerId: provider.id,
        modelId: 'both-ways',
        source: 'discovered',
      });

      const model = (await registry.listModels(provider.id))[0];
      assertEqual(model.capabilities.favourite, true, 'star survives rediscovery');
    });

    it('Q5: export/import carries the star across', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://star.test/v1' });
      await registry.upsertModel({
        providerId: provider.id,
        modelId: 'keep-me',
        source: 'pasted',
        capabilities: { favourite: true },
      });

      const payload = await registry.exportAll();
      const fresh = new Registry(new MemoryStorage());
      await fresh.importAll(JSON.parse(JSON.stringify(payload)));

      const model = (await fresh.listModels())[0];
      assertEqual(model.modelId, 'keep-me', 'model imported');
      assertEqual(model.capabilities.favourite, true, 'star survives export/import');
    });

    it('Q6: un-starring removes the model from quick targets', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://star.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-quick-fixture-3' });
      await registry.upsertModel({
        providerId: provider.id,
        modelId: 'toggle-me',
        source: 'pasted',
        capabilities: { favourite: true },
      });
      await registry.upsertMapping({ providerId: provider.id, modelId: 'toggle-me', keyId: key.id });
      const mapping = (await registry.listMappings())[0];
      await registry.updateMapping(mapping.id, { lastTestAt: new Date().toISOString() });

      const engine = new TestEngine(registry);
      assertEqual((await engine.quickTargets()).length, 1, 'starred model is a target');

      await registry.setModelCapabilities(provider.id, 'toggle-me', { favourite: false });
      assertEqual((await engine.quickTargets()).length, 0, 'un-starred and already tested: no longer a target');
    });
  });
}
