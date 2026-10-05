import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { importPaste } from '../core/pipeline.js';
import { STATUS } from '../core/statuses.js';

const OK_MODELS = { body: { data: [{ id: 'space-bunny-free' }, { id: 'gpt-4o' }] } };
const OK_CHAT = { body: { choices: [{ message: { content: 'OK' } }] } };
const KEY = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';

export function registerKeyScanCases(mockFetch) {
  describe('K. Key auto-scan and tree mapping (plan 7, 23)', () => {
    it('K1: key pasted FIRST is auto-mapped once a provider appears', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = OK_MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: KEY, onProgress: () => {} });
      assertEqual((await registry.listKeys()).length, 0, 'no provider yet, key parked');
      assertEqual((await registry.listUnresolved()).length, 1, 'key is waiting');

      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });

      const keys = await registry.listKeys();
      const mappings = await registry.listMappings();
      assertEqual(keys.length, 1, 'key materialised into the provider');
      assertEqual(mappings.length, 2, 'key mapped to both discovered models');
      assert(mappings.every((m) => m.verified), 'mappings verified by inference');
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox cleared');
    });

    it('K2: model pasted FIRST also lands in the tree once a key exists', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { body: { data: [{ id: 'gpt-4o' }] } };
      mockFetch.routes['/chat/completions'] = OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'fledge-alpha-free', onProgress: () => {} });
      assertEqual((await registry.listModels()).length, 0, 'no provider yet');

      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\n${KEY}`,
        onProgress: () => {},
      });

      const mappings = await registry.listMappings();
      assert(
        mappings.some((m) => m.modelId === 'fledge-alpha-free'),
        'the previously parked model is mapped'
      );
      assert(mappings.every((m) => m.verified), 'and verified');
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox cleared');
    });

    it('K3: a key rejected by every provider stays Unresolved with candidates', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = {
        status: 401,
        body: { error: { message: 'Incorrect API key provided' } },
      };
      mockFetch.routes['/chat/completions'] = OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: KEY, onProgress: () => {} });
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });

      assertEqual((await registry.listKeys()).length, 0, 'no key record created on failure');
      const pending = await registry.listUnresolved();
      assertEqual(pending.length, 1, 'key still parked, never dropped');
      assert(pending[0].candidates.length > 0, 'attempt result recorded as candidate');
      assert(
        pending[0].candidates.some((c) => c.includes('AUTH_INVALID')),
        'candidate explains why: ' + pending[0].candidates.join(',')
      );
    });

    it('K4: key is tried against a second provider when the first rejects it', async () => {
      mockFetch.reset();
      // opencode rejects the key; openrouter accepts it.
      mockFetch.routes['/models'] = (url) =>
        url.includes('opencode.ai')
          ? { status: 401, body: { error: { message: 'Incorrect API key provided' } } }
          : OK_MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: KEY, onProgress: () => {} });
      await importPaste({ registry, raw: 'https://opencode.ai/zen/v1', onProgress: () => {} });
      assertEqual((await registry.listKeys()).length, 0, 'rejected by opencode');

      await importPaste({ registry, raw: 'https://openrouter.ai/api/v1', onProgress: () => {} });

      const keys = await registry.listKeys();
      assertEqual(keys.length, 1, 'accepted by openrouter');
      assertEqual(keys[0].providerId !== undefined, true, 'bound to the accepting provider');
      const mappings = await registry.listMappings();
      assert(mappings.length > 0, 'mappings created on the accepting provider');
      assertEqual((await registry.listUnresolved()).length, 0, 'inbox cleared');
    });

    it('K5: tree is fully populated - every provider/model/key has mappings', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = OK_MODELS;
      mockFetch.routes['/chat/completions'] = OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://opencode.ai/zen/v1\nmodel: space-bunny-free\n${KEY}`,
        onProgress: () => {},
      });

      const providers = await registry.listProviders();
      const models = await registry.listModels();
      const keys = await registry.listKeys();
      const mappings = await registry.listMappings();

      assertEqual(providers.length, 1, 'provider present');
      assertEqual(keys.length, 1, 'key present');
      assert(models.length >= 2, 'models present');

      // Every discovered model must have a mapping for the key, otherwise the
      // tree renders a model with no keys under it.
      for (const model of models) {
        const hit = mappings.find(
          (m) => m.providerId === model.providerId && m.modelId === model.modelId
        );
        assert(hit, 'mapping exists for ' + model.modelId);
        assertEqual(hit.status, STATUS.HEALTHY, model.modelId + ' is healthy');
        assertEqual(hit.keyId, keys[0].id, model.modelId + ' bound to the key');
      }
    });
  });
}
