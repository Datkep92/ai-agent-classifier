import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { STATUS } from '../core/statuses.js';

const KEY_A = 'oc_sk_A1b2C3d4E5f6G7h8I9j0';

async function seed() {
  const registry = new Registry(new MemoryStorage());
  const a = (await registry.upsertProvider({ baseURL: 'https://a.test/v1' })).provider;
  const b = (await registry.upsertProvider({ baseURL: 'https://b.test/v1' })).provider;
  const key = (await registry.upsertKey({ providerId: a.id, secret: KEY_A })).key;

  await registry.upsertMapping({ providerId: a.id, modelId: 'gpt-4o', keyId: key.id });
  await registry.upsertMapping({ providerId: b.id, modelId: 'gpt-4o', keyId: key.id });
  return { registry, a, b, key };
}

export function registerListMappingsCases() {
  describe('LM. listMappings filtering cannot silently no-op', () => {
    it('LM1: a bare providerId filters, it does not return everything', async () => {
      // This returned ALL mappings before, because a string argument was
      // ignored and every lookup "succeeded". Wrong answers, not errors.
      const { registry, a, b } = await seed();

      const forA = await registry.listMappings(a.id);
      const forB = await registry.listMappings(b.id);

      assertEqual(forA.length, 1, 'one mapping for a');
      assert(forA.every((m) => m.providerId === a.id), 'all belong to a');
      assert(forB.every((m) => m.providerId === b.id), 'all belong to b');
    });

    it('LM2: the object form still works', async () => {
      const { registry, a } = await seed();
      const rows = await registry.listMappings({ providerId: a.id });
      assertEqual(rows.length, 1, 'object filter still filters');
    });

    it('LM3: no argument returns everything', async () => {
      const { registry } = await seed();
      assertEqual((await registry.listMappings()).length, 2, 'unfiltered');
      assertEqual((await registry.listMappings({})).length, 2, 'empty filter is unfiltered');
    });

    it('LM4: keyId filter works in both forms', async () => {
      const { registry, key } = await seed();
      const byObject = await registry.listMappings({ keyId: key.id });
      assertEqual(byObject.length, 2, 'key serves both providers');
      assertEqual((await registry.listMappings({ keyId: 'nope' })).length, 0, 'unknown key');
    });

    it('LM5: verified filter is honoured, not skipped', async () => {
      const { registry, a } = await seed();
      const rows = await registry.listMappings({ providerId: a.id });
      const id = rows[0].id;

      assertEqual((await registry.listMappings({ verified: false })).length, 2, 'unverified');
      await registry.updateMapping(id, { verified: true });
      assertEqual((await registry.listMappings({ verified: false })).length, 1, 'one left');
      assertEqual((await registry.listMappings({ verified: true })).length, 1, 'one verified');
    });
  });
}
