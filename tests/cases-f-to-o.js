import { describe, it, assert, assertEqual } from './harness.js';
import { MemoryStorage } from '../core/storage.js';
import { Registry } from '../core/registry.js';
import { Router } from '../core/router.js';
import { probeMapping } from '../core/probe.js';
import { STATUS } from '../core/statuses.js';
import { initialBreaker, recordProviderFailure, isProviderAvailable, refreshBreaker, CIRCUIT_STATE } from '../core/health.js';
import { KEY_A, KEY_B, OK_CHAT } from './cases-a-to-e.js';

const AUTH_FAIL = { status: 401, body: { error: { message: 'Incorrect API key provided' } } };
const RATE_LIMIT = { status: 429, body: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } } };
const QUOTA_429 = { status: 429, body: { error: { message: 'You exceeded your current quota, please check your plan' } } };
const QUOTA_402 = { status: 402, body: { error: { message: 'Insufficient credit balance' } } };
const MODEL_DENIED = { status: 403, body: { error: { message: 'Model gpt-5 is not allowed for this key' } } };
const MODEL_404 = { status: 404, body: { error: { message: 'The model gpt-5 does not exist' } } };
const SERVER_500 = { status: 500, body: { error: { message: 'upstream boom' } } };
const BAD_400 = { status: 400, body: { error: { message: 'max_tokens is invalid' } } };

/** Build a provider+key+model+mapping fixture. */
async function fixture(registry, { baseURL = 'https://api.test.com/v1', modelIds = ['gpt-4o'], secrets = [KEY_A] } = {}) {
  const { provider } = await registry.upsertProvider({ baseURL, name: 'Test' });
  const keys = [];
  for (const secret of secrets) {
    const { key } = await registry.upsertKey({ providerId: provider.id, secret });
    keys.push(key);
  }
  const mappings = [];
  for (const modelId of modelIds) {
    const { model } = await registry.upsertModel({ providerId: provider.id, modelId });
    for (const key of keys) {
      const { mapping } = await registry.upsertMapping({ providerId: provider.id, modelId, keyId: key.id });
      mappings.push({ mapping, model, key });
    }
  }
  return { provider, keys, mappings };
}

export function registerCasesFtoO(mockFetch) {
  describe('F. /models PASS but inference FAIL auth -> classify by inference', () => {
    it('F1: discovery PASS, inference 401 -> key AUTH_INVALID', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { body: { data: [{ id: 'gpt-4o' }] } };
      mockFetch.routes['/chat/completions'] = AUTH_FAIL;
      const registry = new Registry(new MemoryStorage());
      const f = await fixture(registry);
      await probeMapping({ registry, mapping: f.mappings[0].mapping, provider: f.provider, model: f.mappings[0].model, key: f.mappings[0].key });
      const key = await registry.getKey(f.keys[0].id);
      assertEqual(key.status, STATUS.AUTH_INVALID, 'inference auth failure wins over discovery PASS');
    });
  });

  describe('G. 429 rate limit -> cooldown, NOT quota', () => {
    it('G1: plain 429 yields RATE_LIMITED with a cooldown window', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = RATE_LIMIT;
      const registry = new Registry(new MemoryStorage());
      const f = await fixture(registry);
      const result = await probeMapping({ registry, mapping: f.mappings[0].mapping, provider: f.provider, model: f.mappings[0].model, key: f.mappings[0].key });
      assertEqual(result.classification.status, STATUS.RATE_LIMITED, 'rate limited, not quota');
      const { applyFailure } = await import('../core/health.js');
      const next = applyFailure(f.mappings[0].mapping, result.classification);
      assert(next.cooldownUntil > Date.now(), 'cooldown in the future');
    });
  });

  describe('H. Quota exhausted -> excluded from rotation', () => {
    it('H1: 429 with quota wording -> QUOTA_EXHAUSTED', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = QUOTA_429;
      const registry = new Registry(new MemoryStorage());
      const f = await fixture(registry);
      const result = await probeMapping({ registry, mapping: f.mappings[0].mapping, provider: f.provider, model: f.mappings[0].model, key: f.mappings[0].key });
      assertEqual(result.classification.status, STATUS.QUOTA_EXHAUSTED, 'quota from body');
    });

    it('H2: 402 -> QUOTA_EXHAUSTED and router skips it', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = QUOTA_402;
      const registry = new Registry(new MemoryStorage());
      const f = await fixture(registry, { secrets: [KEY_A, KEY_B] });
      for (const m of f.mappings) {
        await probeMapping({ registry, mapping: m.mapping, provider: f.provider, model: m.model, key: m.key });
      }
      const router = new Router(registry);
      const candidates = await router.candidates();
      assertEqual(candidates.length, 0, 'quota-exhausted mappings are not eligible');
    });
  });

  describe('I. Model denied -> only that mapping blocked, key still usable', () => {
    it('I1: MODEL_DENIED disables one mapping, leaves sibling mappings', async () => {
      mockFetch.reset();
      const registry = new Registry(new MemoryStorage());
      const f = await fixture(registry, { modelIds: ['gpt-4o', 'fledge-alpha-free'], secrets: [KEY_A, KEY_B] });

      // Only the (gpt-4o, KEY_A) combination is denied.
      mockFetch.routes['/chat/completions'] = (url, options) => {
        const body = JSON.parse(options.body);
        return body.model === 'gpt-4o' ? MODEL_DENIED : OK_CHAT;
      };

      for (const m of f.mappings) {
        await probeMapping({ registry, mapping: m.mapping, provider: f.provider, model: m.model, key: m.key });
      }

      const denied = await registry.findMapping(f.provider.id, 'gpt-4o', f.keys[0].id);
      assertEqual(denied.status, STATUS.MODEL_DENIED, 'denied mapping flagged');

      const sibling = await registry.findMapping(f.provider.id, 'fledge-alpha-free', f.keys[0].id);
      assertEqual(sibling.status, STATUS.HEALTHY, 'same key works for another model');

      const key = await registry.getKey(f.keys[0].id);
      assert(key.status !== STATUS.AUTH_INVALID, 'key not killed by a model denial');

      const router = new Router(registry);
      const candidates = await router.candidates();
      assert(candidates.length > 0, 'other mappings remain routable');
      assert(
        !candidates.some((c) => c.mapping.id === denied.id),
        'denied mapping excluded from rotation'
      );
    });
  });

  describe('J. Provider 5xx -> fallback to another provider', () => {
    it('J1: failing provider is skipped, healthy provider serves', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = (url) =>
        url.includes('broken.test.com') ? SERVER_500 : OK_CHAT;

      const registry = new Registry(new MemoryStorage());
      const a = await fixture(registry, { baseURL: 'https://broken.test.com/v1', modelIds: ['gpt-4o'] });
      const b = await fixture(registry, { baseURL: 'https://healthy.test.com/v1', modelIds: ['gpt-4o'] });

      // Seed the broken provider as failing at provider scope.
      const { STATUS: S } = await import('../core/statuses.js');
      await registry.updateMapping(a.mappings[0].mapping.id, { status: S.PROVIDER_DOWN, cooldownUntil: null });
      await registry.storage.put('providers', { ...(await registry.getProvider(b.provider.id)), breaker: initialBreaker() });

      const router = new Router(registry);
      const result = await router.complete({
        messages: [{ role: 'user', content: 'hi' }],
        preferredModelId: 'gpt-4o',
      });
      assert(result.ok, 'fallback provider served the request');
      assertEqual(result.candidate.provider.id, b.provider.id, 'healthy provider chosen');
    });
  });

  describe('K. Malformed 400 -> do not burn the whole key pool', () => {
    it('K1: REQUEST_ERROR aborts immediately instead of rotating', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = BAD_400;
      const registry = new Registry(new MemoryStorage());
      await fixture(registry, { modelIds: ['gpt-4o'], secrets: [KEY_A, KEY_B] });

      const router = new Router(registry);
      const result = await router.complete({
        messages: [{ role: 'user', content: 'hi' }],
        preferredModelId: 'gpt-4o',
      });
      assertEqual(result.ok, false, 'request failed');
      assertEqual(result.reason, 'REQUEST_ERROR', 'aborted on malformed request');
      assertEqual(result.tried.length, 1, 'exactly one attempt — no key-pool burn');
      const chatCalls = mockFetch.calls.filter((c) => c.url.includes('/chat/completions'));
      assertEqual(chatCalls.length, 1, 'only one inference request issued');
    });
  });

  describe('L. Duplicate key -> no new record', () => {
    it('L1: pasting the same key twice reuses the record', async () => {
      const registry = new Registry(new MemoryStorage());
      const { provider } = await registry.upsertProvider({ baseURL: 'https://api.test.com/v1' });
      const first = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      const second = await registry.upsertKey({ providerId: provider.id, secret: KEY_A });
      assertEqual(first.key.id, second.key.id, 'same key id');
      assertEqual(second.created, false, 'not created again');
      assertEqual((await registry.listKeys(provider.id)).length, 1, 'still one key');
      assertEqual(first.key.secret, KEY_A, 'secret stored intact');
    });
  });

  describe('M. Duplicate provider (trailing slash) -> no new provider', () => {
    it('M1: /v1/ and /v1/v1 collapse to the same provider', async () => {
      const registry = new Registry(new MemoryStorage());
      const a = await registry.upsertProvider({ baseURL: 'https://opencode.ai/zen/v1/' });
      const b = await registry.upsertProvider({ baseURL: 'https://opencode.ai/zen/v1' });
      const c = await registry.upsertProvider({ baseURL: 'https://opencode.ai/zen/v1/v1' });
      assertEqual(a.provider.id, b.provider.id, 'trailing slash same');
      assertEqual(a.provider.id, c.provider.id, 'duplicate /v1 same');
      assertEqual((await registry.listProviders()).length, 1, 'single provider record');
    });
  });

  describe('N. Unknown provider, OpenAI-compatible -> custom provider created', () => {
    it('N1: never-seen URL is discovered and registered', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { body: { data: [{ id: 'brand-new-model' }] } };
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const { importPaste } = await import('../core/pipeline.js');
      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://totally-unknown-xyz.dev/v1', onProgress: () => {} });
      const providers = await registry.listProviders();
      assertEqual(providers.length, 1, 'custom provider created');
      const models = await registry.listModels(providers[0].id);
      assert(models.some((m) => m.modelId === 'brand-new-model'), 'models discovered');
      assertEqual(providers[0].metadata.discovered, true, 'marked discovered');
    });

    it('N2: discovery fails and /v1 variant also fails -> provider still exists, unresolved kept', async () => {
      mockFetch.reset();
      mockFetch.routes['/models'] = { status: 500, body: { error: { message: 'down' } } };
      const { importPaste } = await import('../core/pipeline.js');
      const registry = new Registry(new MemoryStorage());
      await importPaste({ registry, raw: 'https://dead.example.com/v1', onProgress: () => {} });
      const providers = await registry.listProviders();
      assertEqual(providers.length, 1, 'provider retained for manual recheck');
    });
  });

  describe('O. Circuit breaker -> OPEN skip, HALF_OPEN recover', () => {
    it('O1: breaker opens after threshold and recovers through HALF_OPEN', () => {
      let breaker = initialBreaker();
      assertEqual(breaker.state, CIRCUIT_STATE.CLOSED, 'starts closed');
      for (let i = 0; i < 5; i++) breaker = recordProviderFailure(breaker);
      assertEqual(breaker.state, CIRCUIT_STATE.OPEN, 'opens at threshold');
      assertEqual(isProviderAvailable(breaker), false, 'skipped while open');

      const later = breaker.openedAt + 121_000;
      assertEqual(isProviderAvailable(breaker, { now: later }), true, 'available after open window');
      const half = refreshBreaker(breaker, { now: later });
      assertEqual(half.state, CIRCUIT_STATE.HALF_OPEN, 'half open for one probe');
    });

    it('O2: router skips a provider whose breaker is OPEN', async () => {
      mockFetch.reset();
      mockFetch.routes['/chat/completions'] = OK_CHAT;
      const registry = new Registry(new MemoryStorage());
      const open = await fixture(registry, { baseURL: 'https://opened.test.com/v1', modelIds: ['gpt-4o'] });
      const ok = await fixture(registry, { baseURL: 'https://ready.test.com/v1', modelIds: ['gpt-4o'] });

      let breaker = initialBreaker();
      for (let i = 0; i < 5; i++) breaker = recordProviderFailure(breaker);
      await registry.storage.put('providers', { ...open.provider, breaker });
      await registry.storage.put('providers', { ...ok.provider, breaker: initialBreaker() });

      const router = new Router(registry);
      const chosen = await router.pick({ preferredModelId: 'gpt-4o' });
      assert(chosen, 'a candidate exists');
      assertEqual(chosen.provider.id, ok.provider.id, 'OPEN provider skipped');
    });
  });
}
