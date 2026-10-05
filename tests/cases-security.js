import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { maskSecret, sanitizeError, fingerprintSecret } from '../core/util.js';
import { ingest } from '../core/ingest.js';
import { KEY_A, KEY_B } from './cases-a-to-e.js';

export function registerSecurityCases() {
  describe('Security and invariants (plan 4, 35)', () => {
    it('S1: masked key never exposes the full secret', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.test.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      assert(!key.masked.includes(KEY_A), 'masked key does not contain the secret');
      assert(key.masked.includes('*'), 'masked key has asterisks');
      assertEqual(key.masked, maskSecret(KEY_A), 'mask is the shared helper');
    });

    it('S2: export omits secrets by default', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.test.com/v1' });
      await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      const exported = await registry.exportAll();
      assertEqual(exported.includesSecrets, false, 'flag off');
      const json = JSON.stringify(exported);
      assert(!json.includes(KEY_A), 'no raw secret in export payload');
      for (const k of exported.keys) assert(!('secret' in k), 'key record has no secret field');
    });

    it('S3: export includes secrets only when explicitly requested', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.test.com/v1' });
      await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      const exported = await registry.exportAll({ includeSecrets: true });
      assertEqual(exported.includesSecrets, true, 'flag on');
      assertEqual(exported.keys[0].secret, KEY_A, 'secret present when opted in');
    });

    it('S4: sanitizeError scrubs secrets and bearer tokens', () => {
      const scrubbed = sanitizeError('failed with key ' + KEY_A + ' and Bearer ' + KEY_B, [KEY_A, KEY_B]);
      assert(!scrubbed.includes(KEY_A), 'first secret removed');
      assert(!scrubbed.includes(KEY_B), 'bearer token removed');
      assert(scrubbed.includes('***'), 'masked marker present');
    });

    it('S5: stored error messages never contain the raw secret', async () => {
      bindMockReset();
      getMock().routes['/chat/completions'] = {
        status: 401,
        body: { error: { message: 'Invalid key ' + KEY_A } },
      };
      const { probeMapping } = await import('../core/probe.js');
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.test.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      const { model } = await registry.upsertModel({ providerId: provider.id, modelId: 'gpt-4o' });
      const { mapping } = await registry.upsertMapping({ providerId: provider.id, modelId: 'gpt-4o', keyId: key.id });
      await probeMapping({ registry, mapping, provider, model, key });
      const stored = await registry.getMapping(mapping.id);
      assert(!String(stored.lastErrorMessage).includes(KEY_A), 'mapping error is scrubbed');
      const events = await registry.listEvents();
      assert(!JSON.stringify(events).includes(KEY_A), 'event log is scrubbed');
    });

    it('S6: fingerprints are stable and non-reversible', async () => {
      const a = await fingerprintSecret(KEY_A);
      const b = await fingerprintSecret(KEY_A);
      const c = await fingerprintSecret(KEY_B);
      assertEqual(a, b, 'same secret gives same fingerprint');
      assert(a !== c, 'different secret gives different fingerprint');
      assert(!a.includes(KEY_A), 'fingerprint does not leak the secret');
    });

    it('S7: ingest never throws on garbage input', () => {
      const garbage = ['', '   ', '...', '://', ' ', 'x'.repeat(5000), '{"broken":', 'null'];
      for (const input of garbage) {
        const result = ingest(input);
        assert(Array.isArray(result), 'ingest returns an array for: ' + JSON.stringify(input.slice(0, 12)));
      }
    });

    it('S8: unrecognised input is preserved, never silently dropped', async () => {
      const { importPaste } = await import('../core/pipeline.js');
      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'some totally unknown content', onProgress: () => {} });
      const unresolved = await registry.listUnresolved();
      assertEqual(unresolved.length, 1, 'unknown content parked in Unresolved');
      assertEqual(unresolved[0].raw, 'some totally unknown content', 'raw preserved verbatim');
    });

    it('S9: provider base URL is normalized on every upsert', async () => {
      const registry = new Registry(new MemoryStorage());
      const variants = [
        'https://api.test.com/v1',
        'https://api.test.com/v1/',
        'https://api.test.com/v1/v1',
        'https://api.test.com/v1//models',
      ];
      const ids = new Set();
      for (const v of variants) {
        const { provider } = await registry.upsertProvider({ baseURL: v });
        ids.add(provider.id);
      }
      assertEqual(ids.size, 1, 'all variants map to one provider');
    });
  });
}

let mockRef = null;
export function bindMock(mock) {
  mockRef = mock;
}
function getMock() {
  return mockRef;
}
function bindMockReset() {
  mockRef?.reset?.();
}
