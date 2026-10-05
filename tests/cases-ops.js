import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { TestEngine } from '../core/test-engine.js';
import { CONFIG } from '../core/config.js';
import { STATUS } from '../core/statuses.js';
import { OK_CHAT } from './cases-a-to-e.js';

export function registerOpsCases(mockFetch) {
  describe('Ops. Retention and test actions (plan 20, 31)', () => {
    it('O1: event log stays within the retention limit', async () => {
      const registry = new Registry(new MemoryStorage());
      const limit = CONFIG.eventLogLimit;

      // Write more events than the cap allows.
      for (let i = 0; i < limit + 25; i++) {
        await registry.logEvent({
          kind: 'probe',
          provider: 'P' + i,
          classification: STATUS.HEALTHY,
          latencyMs: i,
        });
      }

      const events = await registry.listEvents(limit * 2);
      assertEqual(events.length, limit, 'log trimmed to the configured limit');
    });

    it('O2: trimming keeps the newest events', async () => {
      const registry = new Registry(new MemoryStorage());
      const limit = CONFIG.eventLogLimit;
      for (let i = 0; i < limit + 5; i++) {
        await registry.logEvent({ kind: 'probe', provider: 'seq-' + i, classification: STATUS.HEALTHY });
      }
      const events = await registry.listEvents(limit * 2);
      const names = events.map((e) => e.provider);
      assert(!names.includes('seq-0'), 'oldest event dropped');
      assert(names.includes('seq-' + (limit + 4)), 'newest event retained');
    });

    it('O3: TEST FAILED only probes the failed mappings', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://ops.test.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-ops-fixture-key' });

      await registry.upsertModel({ providerId: provider.id, modelId: 'bad-model' });
      await registry.upsertModel({ providerId: provider.id, modelId: 'good-model' });

      const failed = await registry.upsertMapping({
        providerId: provider.id,
        modelId: 'bad-model',
        keyId: key.id,
        status: STATUS.AUTH_INVALID,
      });
      await registry.upsertMapping({
        providerId: provider.id,
        modelId: 'good-model',
        keyId: key.id,
        status: STATUS.HEALTHY,
      });

      const engine = new TestEngine(registry);
      const summary = await engine.testAll({ filter: STATUS.AUTH_INVALID, onProgress: () => {} });

      assertEqual(summary.results.length, 1, 'exactly one mapping retested');
      assertEqual(summary.results[0].mappingId, failed.mapping.id, 'the failed one was chosen');
    });

    it('O4: TEST ALL respects the concurrency limit', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://conc.test.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-conc-fixture-key' });

      let inFlight = 0;
      let peak = 0;
      mockFetch.routes['/chat/completions'] = async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return OK_CHAT;
      };

      for (let i = 0; i < 12; i++) {
        await registry.upsertModel({ providerId: provider.id, modelId: 'model-' + i });
        await registry.upsertMapping({
          providerId: provider.id,
          modelId: 'model-' + i,
          keyId: key.id,
          status: STATUS.DISCOVERED,
        });
      }

      const engine = new TestEngine(registry);
      await engine.testAll({ filter: 'all', onProgress: () => {} });

      assert(peak <= CONFIG.testConcurrency, `peak concurrency ${peak} <= limit ${CONFIG.testConcurrency}`);
      assert(peak > 1, 'requests actually overlapped');
    });

    it('O5: a cancelled run stops issuing new requests', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://cancel.test.com/v1' });
      const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-cancel-fixture' });

      for (let i = 0; i < 10; i++) {
        await registry.upsertModel({ providerId: provider.id, modelId: 'm-' + i });
        await registry.upsertMapping({
          providerId: provider.id,
          modelId: 'm-' + i,
          keyId: key.id,
          status: STATUS.DISCOVERED,
        });
      }

      const engine = new TestEngine(registry);
      const run = engine.createRun();
      let calls = 0;
      mockFetch.routes['/chat/completions'] = () => {
        calls += 1;
        run.cancel();
        return OK_CHAT;
      };

      const summary = await engine.testAll({ filter: 'all', run, onProgress: () => {} });
      assert(summary.cancelled, 'run reported as cancelled');
      assert(calls < 10, `stopped early after ${calls} of 10 requests`);
    });
  });
}
