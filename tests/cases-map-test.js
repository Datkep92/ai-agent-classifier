import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { importPaste } from '../core/pipeline.js';
import { TestEngine } from '../core/test-engine.js';
import { probeModelWithoutKey } from '../core/mapper.js';
import { STATUS } from '../core/statuses.js';

const KEY = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const MODELS = { body: { data: [{ id: 'space-bunny-free' }, { id: 'gpt-4o' }] } };
const CHAT_OK = { body: { choices: [{ message: { content: 'OK' } }] } };
const CHAT_NEEDS_KEY = { status: 401, body: { error: { message: 'You must provide an API key' } } };

export function registerMapTestCases(mockFetch) {
  describe('M. Map then test, with and without a key', () => {
    it('M1: URL alone probes every model so the tree carries real results', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = MODELS;
      mockFetch.routes['/chat/completions'] = CHAT_OK;

      const registry = new Registry(new MemoryStorage());
      const report = await importPaste({
        registry,
        raw: 'https://opencode.ai/zen/v1',
        onProgress: () => {},
      });

      assertEqual(report.anonymousProbes, 2, 'both models probed');
      assertEqual(report.workingModels, 2, 'both answered');

      const models = await registry.listModels();
      assertEqual(models.length, 2, 'models present');
      for (const model of models) {
        assert(model.anonymousProbe, model.modelId + ' has a probe record');
        assertEqual(model.anonymousProbe.status, STATUS.HEALTHY, model.modelId + ' healthy');
        assertEqual(model.anonymousProbe.needsKey, false, 'no key was required');
        assertEqual(model.status, STATUS.HEALTHY, 'model status reflects the probe');
      }
    });

    it('M2: a provider that requires a key reports needsKey, never a false green', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = MODELS;
      mockFetch.routes['/chat/completions'] = CHAT_NEEDS_KEY;

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://api.keyrequired.com/v1', onProgress: () => {} });

      const models = await registry.listModels();
      assertEqual(models.length, 2, 'models discovered');
      for (const model of models) {
        assertEqual(model.anonymousProbe.needsKey, true, model.modelId + ' flagged as needing a key');
        assertEqual(model.anonymousProbe.status, STATUS.AUTH_INVALID, 'honest status, not invented');
        assert(
          model.anonymousProbe.status !== STATUS.HEALTHY,
          'must not claim HEALTHY without evidence'
        );
      }
    });

    it('M3: a user-supplied model is probed even when /models does not list it', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { status: 404, body: { error: { message: 'not found' } } };
      mockFetch.routes['/chat/completions'] = CHAT_OK;

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: 'https://no-list.example.com/v1\nmodel: my-secret-model',
        onProgress: () => {},
      });

      const models = await registry.listModels();
      assertEqual(models.length, 1, 'model kept even though /models failed');
      assertEqual(models[0].modelId, 'my-secret-model', 'raw id preserved');
      assert(models[0].anonymousProbe, 'it was actually probed');
      assertEqual(models[0].anonymousProbe.status, STATUS.HEALTHY, 'and it answered');
    });

    it('M4: TEST ALL creates the missing mapping instead of doing nothing', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = MODELS;
      mockFetch.routes['/chat/completions'] = CHAT_OK;

      const registry = new Registry(new MemoryStorage());
      // Provider and models exist, key arrives later without re-import.
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });
      assertEqual((await registry.listMappings()).length, 0, 'no mappings without a key');

      // findProviderByBaseURL returns the record itself, not a wrapper.
      const provider = await registry.findProviderByBaseURL('https://opencode.ai/zen/v1');
      assert(provider, 'provider found');
      await registry.upsertKey({ providerId: provider.id, secret: KEY });

      const engine = new TestEngine(registry);
      const summary = await engine.testAll({ filter: 'all', onProgress: () => {} });

      assertEqual(summary.synthesised, 2, 'two mappings synthesised');
      assertEqual(summary.pass, 2, 'both tested and passed');
      const mappings = await registry.listMappings();
      assertEqual(mappings.length, 2, 'mappings now exist');
      assert(mappings.every((m) => m.verified), 'all verified by real inference');
    });

    it('M5: ensureMappings covers every key x model combination exactly once', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://combo.test.com/v1' });
      const k1 = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      const k2 = await registry.upsertKey({ providerId: provider.id, secret: 'oc_sk_second-fixture-key' });
      for (const id of ['a', 'b', 'c']) {
        await registry.upsertModel({ providerId: provider.id, modelId: id });
      }

      const engine = new TestEngine(registry);
      const first = await engine.ensureMappings();
      assertEqual(first, 6, '2 keys x 3 models');

      const second = await engine.ensureMappings();
      assertEqual(second, 0, 'idempotent: nothing created twice');
      assertEqual((await registry.listMappings()).length, 6, 'exactly six mappings');
      void k1;
      void k2;
    });

    it('M6: a disabled key does not get new mappings', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://dis.test.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      await registry.setKeyEnabled(key.id, false);
      await registry.upsertModel({ providerId: provider.id, modelId: 'only' });

      const engine = new TestEngine(registry);
      const created = await engine.ensureMappings();
      assertEqual(created, 0, 'no mappings created for a disabled key');
    });

    it('M7: probeModelWithoutKey reports honestly on a network failure', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = { __throw: true, message: 'network down' };

      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://dead.test.com/v1' });
      const { model } = await registry.upsertModel({ providerId: provider.id, modelId: 'x' });

      const result = await probeModelWithoutKey({ registry, provider, model });
      assertEqual(result.ok, false, 'not ok');
      assertEqual(result.status, STATUS.TEMP_ERROR, 'classified as a transient error');
      assertEqual(result.needsKey, false, 'not misreported as a key problem');
    });
  });
}
