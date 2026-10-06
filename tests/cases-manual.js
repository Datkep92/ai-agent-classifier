import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { importPaste } from '../core/pipeline.js';
import { STATUS } from '../core/statuses.js';

// Synthetic fixtures. Not real credentials.
const KEY = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';
const OK_CHAT = { body: { choices: [{ message: { content: 'OK' } }] } };
const MODELS = { body: { data: [{ id: 'gpt-4o' }] } };

export function registerManualCases(mockFetch) {
  describe('MN. Manual mapping and key removal', () => {
    it('MN1: a user-attached model lands in the chosen provider', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.upsertProvider({ baseURL: 'https://b.test/v1' });

      const { model, created } = await registry.attachModel({
        providerId: provider.id,
        modelId: 'secret-model-x',
      });

      assert(created, 'model created');
      assertEqual(model.providerId, provider.id, 'attached to the chosen provider');
      assertEqual(model.source, 'manual', 'provenance is a deliberate user choice');
      assertEqual(model.capabilities.favourite, true, 'a model mapped by hand is in use');
      assertEqual((await registry.listModels(provider.id)).length, 1, 'and only there');
    });

    it('MN2: attaching twice updates in place, never duplicates', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });

      await registry.attachModel({ providerId: provider.id, modelId: 'dup-model' });
      const second = await registry.attachModel({ providerId: provider.id, modelId: 'dup-model' });

      assertEqual(second.created, false, 'second attach is not a create');
      assertEqual((await registry.listModels(provider.id)).length, 1, 'still one row');
    });

    it('MN3: an empty model id is rejected, never stored blank', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });

      let threw = false;
      try {
        await registry.attachModel({ providerId: provider.id, modelId: '   ' });
      } catch {
        threw = true;
      }
      assert(threw, 'blank model id rejected');
      assertEqual((await registry.listModels(provider.id)).length, 0, 'nothing stored');
    });

    it('MN4: a removed key is really gone, with its mappings', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      const { model } = await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      await registry.upsertMapping({ providerId: provider.id, modelId: model.modelId, keyId: key.id });

      const removed = await registry.removeKey(key.id);

      assertEqual(removed, true, 'reported as removed');
      assertEqual((await registry.getKey(key.id)), null, 'secret is gone from storage');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'no key row remains');
      const orphan = (await registry.listMappings(provider.id)).filter((m) => m.keyId === key.id);
      assertEqual(orphan.length, 0, 'mappings referencing it are gone, not left dangling');
    });

    it('MN5: a deleted key is remembered so re-pasting does not resurrect it', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      await registry.removeKey(key.id);

      const revived = await registry.upsertKey({ providerId: provider.id, secret: KEY });

      assertEqual(revived.created, false, 're-pasting does not recreate it');
      assertEqual(revived.blocked, true, 'and the caller is told it was refused');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'still deleted');
    });

    it('MN6: the blocklist is per provider, so the same key elsewhere still works', async () => {
      const registry = new Registry(new MemoryStorage());
      const a = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const b = await registry.upsertProvider({ baseURL: 'https://b.test/v1' });

      const { key } = await registry.upsertKey({ providerId: a.provider.id, secret: KEY });
      await registry.removeKey(key.id);

      const other = await registry.upsertKey({ providerId: b.provider.id, secret: KEY });
      assertEqual(other.created, true, 'a different provider still accepts the same secret');
    });

    it('MN7: un-deleting restores the key on request', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      await registry.removeKey(key.id);

      const restored = await registry.restoreKey(provider.id, KEY);

      assertEqual(restored.created, true, 'restored as a live key');
      assertEqual(restored.key.secret, KEY, 'with the original secret');
      assertEqual((await registry.listKeys(provider.id)).length, 1, 'back in the tree');
    });

    it('MN8: a blocked key parked in the inbox is not silently dropped', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      await registry.removeKey(key.id);

      // The same secret arrives again in a paste.
      const { item } = await registry.addUnresolved({
        raw: KEY,
        detectedType: 'API_KEY',
        candidates: [],
      });
      const refreshed = await registry.storage.get('unresolved', item.id);
      assert(refreshed, 'parked item exists');
      assertEqual((await registry.listKeys(provider.id)).length, 0, 'and no key was resurrected');
    });

    it('MN9: export omits a deleted key even if secrets are included', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      await registry.removeKey(key.id);

      const payload = await registry.exportAll({ includeSecrets: true });
      assert(
        !payload.keys.some((k) => k.secret === KEY),
        'a deleted secret never reappears in an export'
      );
      assert(!JSON.stringify(payload).includes(KEY), 'not anywhere in the payload');
    });

    it('MN10: manual attach probes with the provider key and records the verdict', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY}`,
        onProgress: () => {},
      });

      const provider = (await registry.listProviders())[0];
      const { model } = await registry.attachModel({
        providerId: provider.id,
        modelId: 'manually-mapped-model',
        probe: true,
        registry,
      });

      assert(model, 'model exists');
      const mapping = (await registry.listMappings(provider.id)).find(
        (m) => m.modelId === 'manually-mapped-model'
      );
      assert(mapping, 'a mapping was created against the existing key');
      assertEqual(mapping.status, STATUS.HEALTHY, 'and it was actually probed, not assumed');
    });

    it('MN11: manual attach survives export/import', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
      await registry.attachModel({ providerId: provider.id, modelId: 'keep-manual' });

      const payload = await registry.exportAll();
      const fresh = new Registry(new MemoryStorage());
      await fresh.importAll(JSON.parse(JSON.stringify(payload)));

      const models = await fresh.listModels();
      assertEqual(models.length, 1, 'model came back');
      assertEqual(models[0].source, 'manual', 'still marked as a manual choice');
      assertEqual(models[0].capabilities.favourite, true, 'still starred');
    });
  });
}
