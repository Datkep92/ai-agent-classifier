import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { Router } from '../core/router.js';
import { STATUS } from '../core/statuses.js';
import { CONFIG } from '../core/config.js';
import { initialBreaker, recordProviderFailure, CIRCUIT_STATE } from '../core/health.js';

async function seed(registry, { baseURL = 'https://rec.test.com/v1', modelIds = ['gpt-4o'] } = {}) {
  const { provider } = await registry.upsertProvider({ baseURL, name: 'Rec' });
  const { key } = await registry.upsertKey({ providerId: provider.id, secret: 'sk-recovery-fixture-key' });
  const mappings = [];
  for (const modelId of modelIds) {
    const { mapping } = await registry.upsertMapping({
      providerId: provider.id,
      modelId,
      keyId: key.id,
      status: STATUS.HEALTHY,
    });
    mappings.push(mapping);
  }
  return { provider, key, mappings };
}

export function registerRecoveryCases(mockFetch) {
  describe('R. Auto-recovery (plan 19, 18)', () => {
    it('R1: expired cooldown makes a rate-limited mapping routable again', async () => {
      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);
      const past = Date.now() - 60_000;
      await registry.updateMapping(f.mappings[0].id, {
        status: STATUS.RATE_LIMITED,
        cooldownUntil: past,
        failureCount: 2,
      });

      const router = new Router(registry);
      const before = await router.registry.listMappings();
      assertEqual(before[0].cooldownUntil <= Date.now(), true, 'cooldown is in the past');

      const candidates = await router.candidates();
      assert(candidates.length > 0, 'expired cooldown is eligible again');

      const after = await registry.getMapping(f.mappings[0].id);
      assertEqual(after.cooldownUntil, null, 'stale cooldown cleared');
    });

    it('R2: a future cooldown still blocks rotation', async () => {
      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);
      await registry.updateMapping(f.mappings[0].id, {
        status: STATUS.RATE_LIMITED,
        cooldownUntil: Date.now() + 60_000,
      });
      const router = new Router(registry);
      const candidates = await router.candidates();
      assertEqual(candidates.length, 0, 'active cooldown still excluded');
    });

    it('R3: terminal states are never auto-cleared', async () => {
      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry, { modelIds: ['a', 'b', 'c', 'd'] });
      for (const [index, terminal] of [
        STATUS.AUTH_INVALID,
        STATUS.EXPIRED,
        STATUS.QUOTA_EXHAUSTED,
        STATUS.AUTH_INVALID,
      ].entries()) {
        await registry.updateMapping(f.mappings[index].id, {
          status: terminal,
          cooldownUntil: Date.now() - 60_000,
        });
      }

      const router = new Router(registry);
      await router.recover({ now: Date.now() });

      const after = await registry.listMappings();
      for (const mapping of after) {
        assert(
          [
            STATUS.AUTH_INVALID,
            STATUS.EXPIRED,
            STATUS.QUOTA_EXHAUSTED,
          ].includes(mapping.status),
          'terminal status untouched by recovery: ' + mapping.status
        );
      }
      assertEqual(
        await router.candidates().then((c) => c.length),
        0,
        'terminal mappings stay out of rotation'
      );
    });

    it('R4: stale TEMP_ERROR clears so the provider is retried', async () => {
      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);
      const oldFailure = new Date(Date.now() - CONFIG.cooldown.tempErrorMaxMs - 1000).toISOString();
      await registry.updateMapping(f.mappings[0].id, {
        status: STATUS.TEMP_ERROR,
        failureCount: 3,
        cooldownUntil: null,
        lastFailureAt: oldFailure,
        lastErrorClass: STATUS.TEMP_ERROR,
      });

      const router = new Router(registry);
      await router.recover({ now: Date.now() });

      const after = await registry.getMapping(f.mappings[0].id);
      assertEqual(after.status, STATUS.DISCOVERED, 'stale temp error cleared');
      assertEqual(after.failureCount, 0, 'failure counter reset');
      assert((await router.candidates()).length > 0, 'provider is retried');
    });

    it('R5: a recent TEMP_ERROR is NOT prematurely cleared', async () => {
      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);
      await registry.updateMapping(f.mappings[0].id, {
        status: STATUS.TEMP_ERROR,
        failureCount: 1,
        lastFailureAt: new Date().toISOString(),
      });
      const router = new Router(registry);
      await router.recover({ now: Date.now() });
      const after = await registry.getMapping(f.mappings[0].id);
      assertEqual(after.status, STATUS.TEMP_ERROR, 'recent error preserved');
    });

    it('R6: OPEN breaker moves to HALF_OPEN after the open window', async () => {
      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);

      let breaker = initialBreaker();
      for (let i = 0; i < CONFIG.circuit.failureThreshold; i++) breaker = recordProviderFailure(breaker);
      await registry.storage.put('providers', { ...f.provider, breaker });
      assertEqual(breaker.state, CIRCUIT_STATE.OPEN, 'breaker opened');

      const router = new Router(registry);
      assertEqual((await router.candidates()).length, 0, 'OPEN provider skipped');

      const later = breaker.openedAt + CONFIG.circuit.openMs + 1000;
      await router.recover({ now: later });

      const stored = await registry.getProvider(f.provider.id);
      assertEqual(stored.breaker.state, CIRCUIT_STATE.HALF_OPEN, 'moved to HALF_OPEN');

      const candidates = await router.candidates({ now: later });
      assertEqual(candidates.length, 1, 'exactly one probe allowed in HALF_OPEN');
    });

    it('R7: HALF_OPEN permits exactly one probe, then blocks', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = { body: { choices: [{ message: { content: 'OK' } }] } };

      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);
      let breaker = initialBreaker();
      for (let i = 0; i < CONFIG.circuit.failureThreshold; i++) breaker = recordProviderFailure(breaker);
      breaker = { ...breaker, state: CIRCUIT_STATE.HALF_OPEN, halfOpenProbes: 0 };
      await registry.storage.put('providers', { ...f.provider, breaker });

      const router = new Router(registry);
      const first = await router.candidates({ now: Date.now() });
      assertEqual(first.length, 1, 'probe slot available');

      // Simulate the probe being spent.
      await registry.storage.put('providers', {
        ...(await registry.getProvider(f.provider.id)),
        breaker: { ...breaker, halfOpenProbes: breaker.halfOpenProbes + 1 },
      });
      const second = await router.candidates({ now: Date.now() });
      assertEqual(second.length, 0, 'no further probes until the window resets');
    });

    it('R8: successful request closes the breaker', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = { body: { choices: [{ message: { content: 'OK' } }] } };

      const registry = new Registry(new MemoryStorage());
      const f = await seed(registry);
      let breaker = initialBreaker();
      for (let i = 0; i < CONFIG.circuit.failureThreshold; i++) breaker = recordProviderFailure(breaker);
      breaker = { ...breaker, state: CIRCUIT_STATE.HALF_OPEN };
      await registry.storage.put('providers', { ...f.provider, breaker });

      const router = new Router(registry);
      const result = await router.complete({
        messages: [{ role: 'user', content: 'hi' }],
        preferredModelId: 'gpt-4o',
      });
      assert(result.ok, 'probe succeeded');

      const stored = await registry.getProvider(f.provider.id);
      assertEqual(stored.breaker.state, CIRCUIT_STATE.CLOSED, 'breaker closed after success');
    });
  });
}
