import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { maskSecret } from '../core/util.js';
import { importPaste } from '../core/pipeline.js';
import { createMockFetch } from './mock-fetch.js';

const KEY = 'sk-proj-T1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const MODELS = { body: { data: [{ id: 'gpt-4o' }] } };
const CHAT = { body: { choices: [{ message: { content: 'OK' } }] } };

export function registerSecretUiCases(mockFetch) {
  describe('U. Secret handling for display', () => {
    it('U1: the full secret is retrievable for on-demand display', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = MODELS;
      mockFetch.routes['/chat/completions'] = CHAT;

      const registry = new Registry(new MemoryStorage());
      await importPaste({
        registry,
        raw: `https://api.openai.com/v1\n${KEY}`,
        onProgress: () => {},
      });

      const keys = await registry.listKeys();
      assertEqual(keys.length, 1, 'key stored');
      assertEqual(keys[0].secret, KEY, 'full secret retained so the UI can reveal it');
    });

    it('U2: masked form never equals the secret', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.openai.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: KEY });
      assert(key.masked !== KEY, 'masked differs from secret');
      assert(key.masked.includes('*'), 'masked contains asterisks');
      assert(key.masked.startsWith(KEY.slice(0, 4)), 'keeps a readable head');
      assert(key.masked.endsWith(KEY.slice(-4)), 'keeps a readable tail');
      assertEqual(key.masked, maskSecret(KEY), 'uses the shared helper');
    });

    it('U3: export still omits secrets even though the UI can show them', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.openai.com/v1' });
      await registry.upsertKey({ providerId: provider.id, secret: KEY });

      const exported = await registry.exportAll();
      assert(!JSON.stringify(exported).includes(KEY), 'default export has no secret');
      assertEqual(exported.includesSecrets, false, 'flag stays off');

      // The reveal capability must not become an accidental export path.
      const withSecrets = await registry.exportAll({ includeSecrets: true });
      assertEqual(withSecrets.includesSecrets, true, 'still explicit when asked');
    });

    it('U4: long keys are wrappable rather than overflowing the row', () => {
      // Layout guard: the CSS rule that keeps a long unbroken key from
      // pushing action buttons off screen is min-width:0 + break-all.
      const veryLong = 'sk-' + 'A1b2C3d4E5f6'.repeat(6);
      const masked = maskSecret(veryLong);
      assert(masked.length < veryLong.length, 'masked is shorter than the secret');
      assert(masked.includes('*'), 'middle is elided');
      // The masked form is what renders by default, so it must stay compact.
      assert(masked.length <= 40, 'masked fits a phone row: ' + masked.length);
    });

    it('U5: a short secret is still masked rather than shown bare', () => {
      const short = 'sk-short123';
      const masked = maskSecret(short);
      assert(!masked.includes(short.slice(2, 6)), 'inner characters hidden');
    });

    it('U6: masking never returns more characters than the input', () => {
      const samples = [
        'x',
        'abc',
        'abcdefghi',
        'abcdefghij',
        'abcdefghijk',
        'sk-short123',
        KEY,
        'sk-' + 'A1b2C3d4E5f6'.repeat(6),
        'a'.repeat(200),
      ];
      for (const sample of samples) {
        const masked = maskSecret(sample);
        assert(
          masked.length <= sample.length,
          `masked longer than input for length ${sample.length}: ${masked.length}`
        );
      }
    });

    it('U7: masking never reveals the whole secret', () => {
      const samples = ['abcdefghij', 'sk-short123', KEY, 'a'.repeat(40)];
      for (const sample of samples) {
        const stripped = maskSecret(sample).replace(/\*/g, '');
        assert(stripped !== sample, 'full secret must not survive masking: length ' + sample.length);
      }
    });

    it('U8: a realistic key masks to a phone-friendly width', () => {
      const masked = maskSecret(KEY);
      assert(masked.length <= 24, 'fits a narrow row: ' + masked.length);
      assert(masked.includes('*'), 'middle elided');
    });
  });
}
