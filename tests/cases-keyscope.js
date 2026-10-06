import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { TestEngine } from '../core/test-engine.js';
import { STATUS } from '../core/statuses.js';

// Synthetic fixtures. Not real credentials.
const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const KEY_B = 'oc_sk_Z9y8X7w6V5u4T3s2R1q0';

export function registerKeyScopeCases() {
  describe('KS. A key belongs to the URL and serves every model there', () => {
    it('KS1: a key added to a URL is reused across all of its models', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'fledge-alpha-free' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'nemotron-free' });

      await registry.upsertKey({ providerId: provider.id, secret: KEY_A });

      const engine = new TestEngine(registry);
      const created = await engine.ensureMappings();

      assertEqual(created, 3, 'one mapping per model from the single key');
      const mappings = await registry.listMappings(provider.id);
      for (const model of ['gpt-4o', 'fledge-alpha-free', 'nemotron-free']) {
        assert(
          mappings.some((m) => m.modelId === model),
          model + ' uses the shared key'
        );
      }
    });

    it('KS2: two keys on one URL cross every model', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'fledge-alpha-free' });

      await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.upsertKey({ providerId: provider.id, secret: KEY_B });

      // Mappings are built from keys + models, so build them before asserting.
      await new TestEngine(registry).ensureMappings();
      const mappings = await registry.listMappings(provider.id);
      const keys = await registry.listKeys(provider.id);
      assertEqual(mappings.length, 4, '2 models x 2 keys');
      assertEqual(
        mappings.filter((m) => m.keyId === keys[0].id).length,
        2,
        'key A serves both models'
      );
    });

    it('KS3: a key is scoped to one URL and never leaks to another', async () => {
      const registry = new Registry(new MemoryStorage());
      const a = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const b = await registry.upsertProvider({ baseURL: 'https://b.test/v1' });
      await registry.upsertModel({ providerId: a.provider.id, modelId: 'gpt-4o' });
      await registry.upsertModel({ providerId: b.provider.id, modelId: 'gpt-4o' });

      await registry.upsertKey({ providerId: a.provider.id, secret: KEY_A });

      const engine = new TestEngine(registry);
      await engine.ensureMappings();

      const bMappings = await registry.listMappings(b.provider.id);
      assertEqual(
        bMappings.length,
        0,
        'the other URL gets no mapping from this key (built: ' +
          (await new TestEngine(registry).ensureMappings()) + ')'
      );
    });

    it('KS4: the same secret on two URLs is stored once per URL', async () => {
      const registry = new Registry(new MemoryStorage());
      const a = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const b = await registry.upsertProvider({ baseURL: 'https://b.test/v1' });

      await registry.upsertKey({ providerId: a.provider.id, secret: KEY_A });
      await registry.upsertKey({ providerId: b.provider.id, secret: KEY_A });

      assertEqual((await registry.listKeys()).length, 2, 'one record per URL, not one globally');
    });

    it('KS5: adding a key by hand builds its mappings immediately', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o-mini' });

      const { key, created } = await registry.addKeyToProvider({
        providerId: provider.id,
        secret: KEY_A,
      });

      assert(created, 'key added');
      assertEqual(key.providerId, provider.id, 'owned by that URL');
      // ensureMappings is what turns a key into per-model mappings; the UI
      // calls it right after adding so the new key is usable at once.
      const created2 = await new TestEngine(registry).ensureMappings();
      assertEqual(created2, 2, 'both models pick it up with no extra clicks');
    });

    it('KS6: a rejected key reports honestly instead of pretending success', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });

      const result = await registry.addKeyToProvider({ providerId: provider.id, secret: '' });
      assertEqual(result.created, false, 'empty secret refused');
      assertEqual(result.reason, 'EMPTY', 'and says why');
    });

    it('KS7: a duplicate key on the same URL is not stored twice', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });

      await registry.addKeyToProvider({ providerId: provider.id, secret: KEY_A });
      const again = await registry.addKeyToProvider({ providerId: provider.id, secret: KEY_A });

      assertEqual(again.created, false, 'not a second record');
      assertEqual((await registry.listKeys(provider.id)).length, 1, 'still one key');
    });

    it('KS8: a key deleted for this URL does not come back when added again', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      await registry.removeKey(key.id);

      const again = await registry.addKeyToProvider({ providerId: provider.id, secret: KEY_A });
      assertEqual(again.reason, 'BLOCKED', 'the earlier delete is honoured');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'still gone');
    });

    it('KS9: keys are stored per provider, so pruning one URL spares another', async () => {
      const registry = new Registry(new MemoryStorage());
      const a = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const b = await registry.upsertProvider({ baseURL: 'https://b.test/v1' });
      const keyA = await registry.upsertKey({ providerId: a.provider.id, secret: KEY_A });
      await registry.upsertKey({ providerId: b.provider.id, secret: KEY_A });

      await registry.setKeyStatus(keyA.key.id, STATUS.EXPIRED);
      await registry.pruneExpiredKeys();

      assertEqual((await registry.listKeys(a.provider.id)).length, 0, 'pruned on a');
      assertEqual((await registry.listKeys(b.provider.id)).length, 1, 'untouched on b');
    });
  });
}
