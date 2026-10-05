import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { importPaste } from '../core/pipeline.js';
import { ingest, groupItems } from '../core/ingest.js';
import { STATUS } from '../core/statuses.js';
import { normalizeBaseURL } from '../core/normalizer.js';

const OK_MODELS = { body: { data: [{ id: 'gpt-4o' }, { id: 'fledge-alpha-free' }, { id: 'nemotron-free' }] } };
const OK_CHAT = { body: { choices: [{ message: { content: 'OK' } }] } };
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

export function registerCasesAtoE(mockFetch) {
  describe('A. Paste URL first -> provider -> discovery', () => {
    it('A1: URL import creates provider and imports discovered models', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = OK_MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      const report = await importPaste({
        registry,
        raw: 'https://opencode.ai/zen/v1',
        onProgress: () => {},
      });
      const providers = await registry.listProviders();
      const models = await registry.listModels();
      assertEqual(providers.length, 1, 'exactly one provider');
      assert(providers[0].baseURL === 'https://opencode.ai/zen/v1', 'base URL normalized');
      assert(models.length >= 3, `discovered models imported, got ${models.length}`);
      assert(report.providersCount === 1, 'report provider count');
    });
  });

  describe('B. Paste model first -> unresolved, auto-resolve after URL', () => {
    it('B1: model alone is parked in Unresolved, never dropped', async () => {
      mockFetch.reset();
      const registry = new Registry(new MemoryStorage());
      const report = await importPaste({ registry, raw: 'space-bunny-free', onProgress: () => {} });
      const unresolved = await registry.listUnresolved();
      assertEqual(unresolved.length, 1, 'one unresolved item');
      assertEqual(unresolved[0].raw, 'space-bunny-free', 'raw preserved');
      assertEqual(unresolved[0].detectedType, 'MODEL', 'typed as MODEL');
      assertEqual(report.unresolved.length, 1, 'report carries unresolved');
    });

    it('B2: pasting the provider URL later auto-resolves the parked model', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { body: { data: [{ id: 'space-bunny-free' }] } };
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());

      await importPaste({ registry, raw: 'space-bunny-free', onProgress: () => {} });
      assertEqual((await registry.listUnresolved()).length, 1, 'still parked');

      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });

      // The parked item is consumed and the model is now owned by a provider.
      const unresolvedAfter = await registry.listUnresolved();
      assertEqual(unresolvedAfter.length, 0, 'unresolved cleared after auto-resolve');

      const models = await registry.listModels();
      assert(
        models.some((m) => m.modelId === 'space-bunny-free'),
        'model materialised against the provider'
      );
      // A Key x Model mapping only exists once a key is present; with no key
      // the model is still resolved and ready to map (§7).
      const keys = await registry.listKeys();
      const mappings = await registry.listMappings();
      if (keys.length > 0) {
        assert(mappings.length >= 1, 'mapping created when a key exists');
      } else {
        assertEqual(keys.length, 0, 'no key yet — mapping correctly not created');
      }
    });

    it('B3: model + URL + key together yields a verified mapping', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { body: { data: [{ id: 'space-bunny-free' }] } };
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());

      await importPaste({ registry, raw: 'space-bunny-free', onProgress: () => {} });
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY_A}`,
        onProgress: () => {},
      });

      const mappings = await registry.listMappings();
      assert(mappings.length >= 1, 'mapping exists');
      assert(
        mappings.some((m) => m.modelId === 'space-bunny-free' && m.verified),
        'resolved model probed and verified'
      );
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox empty');
    });
  });

  describe('C. Paste key first -> candidate provider, map after provider appears', () => {
    it('C1: key alone is parked, never auto-created as a provider', async () => {
      mockFetch.reset();
      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: KEY_A, onProgress: () => {} });
      const unresolved = await registry.listUnresolved();
      assertEqual(unresolved.length, 1, 'key parked in Unresolved');
      assertEqual(unresolved[0].detectedType, 'API_KEY', 'typed as API_KEY');
      assertEqual((await registry.listProviders()).length, 0, 'no provider invented');
    });

    it('C2: key + URL together creates exactly one key record (no duplicate)', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = OK_MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY_A}`,
        onProgress: () => {},
      });
      const keys = await registry.listKeys();
      assertEqual(keys.length, 1, 'exactly one key stored');
      assertEqual((await registry.listMappings()).length, 3, 'mapped to each discovered model');
    });
  });

  describe('D. Mixed paste classifies correctly without duplicates', () => {
    it('D1: mixed blob yields url + models + keys, each once', () => {
      const groups = groupItems(
        ingest(`https://openrouter.ai/api/v1
model: gpt-4o
${KEY_A}
gpt-4o`)
      );
      assertEqual(groups.urls.length, 1, 'one url');
      assertEqual(groups.models.length, 1, 'model deduped');
      assertEqual(groups.keys.length, 1, 'one key');
    });

    it('D2: re-pasting the same blob creates nothing new', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = OK_MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      const blob = `https://opencode.ai/zen/v1\nmodel: gpt-4o\n${KEY_A}`;

      await importPaste({ registry, raw: blob, onProgress: () => {} });
      const first = {
        providers: (await registry.listProviders()).length,
        keys: (await registry.listKeys()).length,
        models: (await registry.listModels()).length,
        mappings: (await registry.listMappings()).length,
      };
      await importPaste({ registry, raw: blob, onProgress: () => {} });
      const second = {
        providers: (await registry.listProviders()).length,
        keys: (await registry.listKeys()).length,
        models: (await registry.listModels()).length,
        mappings: (await registry.listMappings()).length,
      };
      assertEqual(JSON.stringify(second), JSON.stringify(first), 'registry unchanged on re-paste');
    });
  });

  describe('E. /models FAIL but inference PASS -> HEALTHY, never INVALID', () => {
    it('E1: discovery fails, inference passes -> mapping verified HEALTHY', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { status: 404, body: { error: { message: 'not found' } } };
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());

      // Seed a model so an inference probe is possible without discovery.
      const { provider } = await registry.upsertProvider({ baseURL: 'https://flaky.example.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o', source: 'pasted' });
      const { mapping } = await registry.upsertMapping({
        providerId: provider.id,
        modelId: 'gpt-4o',
        keyId: key.id,
      });

      const { probeMapping } = await import('../core/probe.js');
      const model = (await registry.findModel(provider.id, 'gpt-4o'));
      const result = await probeMapping({ registry, mapping, provider, model, key });

      assert(result.ok, 'inference passed despite /models 404');
      assertEqual(result.classification.status, STATUS.HEALTHY, 'status is HEALTHY');
      const stored = await registry.getMapping(mapping.id);
      assertEqual(stored.status, STATUS.HEALTHY, 'persisted HEALTHY');
      assertEqual(stored.verified, true, 'marked verified');
      assert(stored.status !== STATUS.AUTH_INVALID, 'never INVALID');
      const keyAfter = await registry.getKey(key.id);
      assert(keyAfter.status !== STATUS.AUTH_INVALID, 'key not killed by discovery failure');
    });
  });
}

export { KEY_A, KEY_B, OK_MODELS, OK_CHAT };
