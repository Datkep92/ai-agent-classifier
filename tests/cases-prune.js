import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { TestEngine } from '../core/test-engine.js';
import { importPaste, syncAllProviders } from '../core/pipeline.js';
import { STATUS, TERMINAL_STATUS } from '../core/statuses.js';
import { createMockFetch } from './mock-fetch.js';

// Synthetic fixtures. Not real credentials.
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const OK_CHAT = { body: { choices: [{ message: { content: 'OK' } }] } };
const MODELS = { body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] } };

function useRoutes(routes) {
  const mock = createMockFetch(routes);
  globalThis.fetch = mock;
  return mock;
}

export function registerPruneCases() {
  describe('PR. Remembering rejections so nothing is retried for nothing', () => {
    it('PR1: a model that failed on a provider is not re-probed there on the next sweep', async () => {
      const mock = useRoutes({
        '/models': MODELS,
        '/chat/completions': { status: 404, body: { error: { message: 'model not found' } } },
      });

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY_A}`,
        onProgress: () => {},
      });

      const before = mock.calls.filter((c) => c.url.includes('/chat/completions')).length;
      assert(before > 0, 'the first sweep actually probed');

      await syncAllProviders({ registry, force: true });
      const after = mock.calls.filter((c) => c.url.includes('/chat/completions')).length;

      assertEqual(after, before, 'a model already disproved is not probed again');
    });

    it('PR2: a rejection is remembered per model, not per provider', async () => {
      const mock = useRoutes({
        '/models': MODELS,
        '/chat/completions': { status: 404, body: { error: { message: 'model not found' } } },
      });

      const registry = new Registry(new MemoryStorage());
      const a = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const b = await registry.upsertProvider({ baseURL: 'https://b.test/v1' });
      const { key } = await registry.upsertKey({ providerId: a.provider.id, secret: KEY_A });

      const aIdentity = a.provider.identity;
      const bIdentity = b.provider.identity;

      await registry.recordRejectedModel(aIdentity, 'bad-model');
      const skip = await registry.shouldProbeModel(aIdentity, 'bad-model');
      const other = await registry.shouldProbeModel(bIdentity, 'bad-model');

      assertEqual(skip, false, 'same provider skips it');
      assertEqual(other, true, 'a different provider still tries it');
      assert(key, 'key exists');
    });

    it('PR3: mapping a model by hand clears the rejection so it is retried', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.recordRejectedModel(provider.identity, 'was-rejected');

      assertEqual(
        await registry.shouldProbeModel(provider.identity, 'was-rejected'),
        false,
        'blocked'
      );

      await registry.attachModel({ providerId: provider.id, modelId: 'was-rejected' });

      assertEqual(
        await registry.shouldProbeModel(provider.identity, 'was-rejected'),
        true,
        'a manual map is an explicit instruction to try again'
      );
    });

    it('PR4: a rejected model is remembered without storing any secret', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.recordRejectedModel(provider.identity, 'bad-model', 'NOT_AVAILABLE');

      const records = await registry.listRejectedModels();
      assertEqual(records.length, 1, 'recorded');
      assert(!JSON.stringify(records).includes(KEY_A), 'no secret in the record');
      assertEqual(records[0].modelId, 'bad-model', 'keyed by model');
    });

    it('PR5: an expired key is dropped and stops producing mappings', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.setKeyStatus(key.id, STATUS.EXPIRED);

      const pruned = await registry.pruneExpiredKeys();

      assertEqual(pruned, 1, 'one key expired');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'key is gone');

      const engine = new TestEngine(registry);
      await engine.ensureMappings();
      assertEqual((await registry.listMappings(provider.id)).length, 0, 'no mappings rebuilt');
    });

    it('PR6: an invalid-auth key is pruned too, same as expired', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });

      await registry.setKeyStatus(key.id, STATUS.AUTH_INVALID);
      const pruned = await registry.pruneExpiredKeys();

      assertEqual(pruned, 1, 'invalid auth pruned');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'key gone');
    });

    it('PR7: a healthy key is never pruned', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });

      await registry.setKeyStatus(key.id, STATUS.HEALTHY);
      const pruned = await registry.pruneExpiredKeys();

      assertEqual(pruned, 0, 'nothing pruned');
      assertEqual((await registry.listKeys(provider.id)).length, 1, 'key still here');
    });

    it('PR8: pruning is remembered, so the same dead key is not re-added by a paste', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.setKeyStatus(key.id, STATUS.EXPIRED);
      await registry.pruneExpiredKeys();

      const again = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      assertEqual(again.blocked, true, 're-pasting a dead key does not resurrect it');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'still gone');
    });

    it('PR9: TEST ALL does not re-probe a mapping whose key was pruned', async () => {
      useRoutes({ '/chat/completions': OK_CHAT });

      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.setKeyStatus(key.id, STATUS.EXPIRED);
      await registry.pruneExpiredKeys();

      const engine = new TestEngine(registry);
      const summary = await engine.testAll({ filter: 'all' });

      assertEqual(summary.results.length, 0, 'nothing to test against a dead key');
    });

    it('PR10: quick test also skips pruned keys', async () => {
      useRoutes({ '/chat/completions': OK_CHAT });

      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.setKeyStatus(key.id, STATUS.EXPIRED);
      await registry.pruneExpiredKeys();

      const engine = new TestEngine(registry);
      assertEqual((await engine.quickTargets()).length, 0, 'no targets');
    });

    it('PR11: a restored key comes back and is testable again', async () => {
      useRoutes({ '/chat/completions': OK_CHAT });

      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.setKeyStatus(key.id, STATUS.EXPIRED);
      await registry.pruneExpiredKeys();

      const back = await registry.restoreKey(provider.id, KEY_A);
      assertEqual(back.created, true, 'restored');
      assertEqual(back.key.providerId, provider.id, 'and attached to the same provider');

      const engine = new TestEngine(registry);
      const created = await engine.ensureMappings();
      assertEqual(created, 1, 'mappings are built again for the restored key');
    });

    it('PR12: terminal statuses are exactly the prunable set', () => {
      // Guard against widening: a rate limit must never evict a key.
      assert(TERMINAL_STATUS.has(STATUS.EXPIRED), 'expired prunable');
      assert(TERMINAL_STATUS.has(STATUS.AUTH_INVALID), 'invalid prunable');
      assert(!TERMINAL_STATUS.has(STATUS.RATE_LIMITED), 'rate limit not prunable');
      assert(!TERMINAL_STATUS.has(STATUS.TEMP_ERROR), 'temp error not prunable');
      assert(!TERMINAL_STATUS.has(STATUS.MODEL_DENIED), 'model denied is not key-scoped');
    });
  });
}
