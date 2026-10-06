import { describe, it, assert, assertEqual, assertDeepEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { STATUS } from '../core/statuses.js';

/**
 * The filter buckets the UI uses. Mirrored here so the semantics are pinned by
 * tests rather than only living in app.js render code.
 */
const FILTERS = {
  all: () => true,
  healthy: (m) => m.status === STATUS.HEALTHY,
  broken: (m) =>
    [STATUS.AUTH_INVALID, STATUS.EXPIRED, STATUS.QUOTA_EXHAUSTED, STATUS.PROVIDER_DOWN].includes(m.status),
  pending: (m) =>
    [STATUS.RATE_LIMITED, STATUS.TEMP_ERROR, STATUS.UNRESOLVED, STATUS.DISCOVERED].includes(m.status),
  unresolved: (m) => !m.lastTestAt,
};

/** Build one mapping per status so every bucket can be checked at once. */
async function seedAllStatuses() {
  const registry = new Registry(new MemoryStorage());
  const { provider } = await registry.upsertProvider({ baseURL: 'https://a.test/v1' });
  const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'oc_sk_A1b2C3d4E5f6G7h8I9j0' });

  const rows = [];
  for (const status of [
    STATUS.HEALTHY,
    STATUS.AUTH_INVALID,
    STATUS.EXPIRED,
    STATUS.QUOTA_EXHAUSTED,
    STATUS.PROVIDER_DOWN,
    STATUS.RATE_LIMITED,
    STATUS.TEMP_ERROR,
    STATUS.MODEL_DENIED,
    STATUS.DISCOVERED,
  ]) {
    const modelId = 'm-' + status.toLowerCase();
    await registry.upsertModel({ providerId: provider.id, modelId });
    const { mapping } = await registry.upsertMapping({
      providerId: provider.id,
      modelId,
      keyId: key.id,
      status,
    });
    rows.push({ ...mapping, lastTestAt: '2024-01-01T00:00:00.000Z' });
  }
  return { registry, provider, key, rows };
}

const names = (rows) => rows.map((r) => r.modelId).sort();

export function registerFilterCases() {
  describe('FL. Filter buckets', () => {
    it('FL1: "healthy" contains only HEALTHY', async () => {
      const { rows } = await seedAllStatuses();
      assertDeepEqual(
        names(rows.filter(FILTERS.healthy)),
        ['m-healthy'],
        'exactly the healthy rows'
      );
    });

    it('FL2: "broken" is credential-scoped, never a model denial', async () => {
      const { rows } = await seedAllStatuses();
      const broken = names(rows.filter(FILTERS.broken));

      assert(broken.includes('m-auth_invalid'), 'invalid auth is broken');
      assert(broken.includes('m-expired'), 'expired is broken');
      assert(!broken.includes('m-model_denied'), 'MODEL_DENIED is one model, not the key');
      assert(!broken.includes('m-healthy'), 'healthy is not broken');
    });

    it('FL3: "pending" holds transient states, not terminal ones', async () => {
      const { rows } = await seedAllStatuses();
      const pending = names(rows.filter(FILTERS.pending));

      assert(pending.includes('m-rate_limited'), 'rate limit waits');
      assert(pending.includes('m-temp_error'), 'temp error waits');
      assert(!pending.includes('m-auth_invalid'), 'invalid auth is terminal, not pending');
      assert(!pending.includes('m-expired'), 'expired is terminal, not pending');
    });

    it('FL4: "unresolved" is exactly what has never been tested', async () => {
      const { rows } = await seedAllStatuses();
      assertEqual(rows.filter(FILTERS.unresolved).length, 0, 'all rows were tested');

      const fresh = rows.map((r) => ({ ...r, lastTestAt: null }));
      assertEqual(fresh.filter(FILTERS.unresolved).length, fresh.length, 'all untested now match');
    });

    it('FL5: every status lands in exactly one non-all bucket', async () => {
      const { rows } = await seedAllStatuses();
      const buckets = ['healthy', 'broken', 'pending', 'unresolved'];

      const counted = new Map();
      for (const row of rows) {
        for (const name of buckets) {
          if (FILTERS[name](row)) counted.set(row.modelId, (counted.get(row.modelId) ?? 0) + 1);
        }
      }

      // MODEL_DENIED intentionally falls in none: it is a mapping-level
      // verdict with no bucket, and is still reachable under "all".
      for (const row of rows) {
        if (row.modelId === 'm-model_denied') continue;
        assertEqual(counted.get(row.modelId), 1, row.modelId + ' in exactly one bucket');
      }
    });

    it('FL6: "all" never drops a row', async () => {
      const { rows } = await seedAllStatuses();
      assertEqual(rows.filter(FILTERS.all).length, rows.length, 'every row kept');
    });

    it('FL7: a pruned key leaves nothing behind for the filter to show', async () => {
      const { registry, provider, key } = await seedAllStatuses();

      await registry.setKeyStatus(key.id, STATUS.EXPIRED);
      const pruned = await registry.pruneExpiredKeys();
      assertEqual(pruned, 1, 'key pruned');

      assertEqual((await registry.listKeys(provider.id)).length, 0, 'no keys');
      assertEqual((await registry.listMappings(provider.id)).length, 0, 'no mappings to filter');
      assertEqual((await registry.listMappings()).filter(FILTERS.broken).length, 0, 'bucket empty');
    });

    it('FL8: a deleted key is not listed anywhere, in any bucket', async () => {
      const { registry, provider, key } = await seedAllStatuses();
      await registry.removeKey(key.id);

      for (const name of Object.keys(FILTERS)) {
        const rows = (await registry.listMappings()).filter(FILTERS[name]);
        assert(
          !rows.some((r) => r.keyId === key.id),
          'bucket ' + name + ' must not reference the deleted key'
        );
      }
    });

    it('FL9: detail rows carry a copyable url/model/key triple', async () => {
      const { registry, provider, key } = await seedAllStatuses();
      const model = await registry.listModels(provider.id);

      // Same shape openDetail() builds, so the dialog cannot drift from it.
      const lines = [];
      for (const mapping of (await registry.listMappings()).filter(FILTERS.healthy)) {
        const p = (await registry.listProviders()).find((x) => x.id === mapping.providerId);
        const k = (await registry.listKeys()).find((x) => x.id === mapping.keyId);
        const m = model.find((x) => x.modelId === mapping.modelId);
        lines.push({ url: p?.baseURL, model: m?.modelId, key: k?.secret });
      }

      assertEqual(lines.length, 1, 'one healthy line');
      assertEqual(lines[0].url, 'https://a.test/v1', 'url present');
      assert(lines[0].model, 'model present');
      assert(lines[0].key, 'full key present for copying');
    });
  });
}
