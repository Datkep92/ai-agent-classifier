import {
  providerIdentity,
  modelIdentity,
  mappingIdentity,
  normalizeBaseURL,
  providerNameFromURL,
  normalizeModelId,
} from './normalizer.js';
import { STATUS } from './statuses.js';
import { fingerprintSecret, maskSecret, makeId, isoNow, nowMs } from './util.js';

/**
 * Registry (§3, §25).
 *
 * Owns: providers, models, keys, mappings, unresolved items.
 * Storage shape mirrors §3 exactly. Keys are stored once per provider and
 * shared across models — we never duplicate a secret per model.
 *
 * Dedupe rules (§25):
 *   provider: normalized baseURL
 *   model:    providerId + exact modelId
 *   key:      fingerprint
 *   mapping:  providerId + modelId + keyId
 */

export class Registry {
  constructor(storage) {
    this.storage = storage;
  }

  // ---------------------------------------------------------------- Providers

  async listProviders() {
    return this.storage.list('providers');
  }

  async getProvider(id) {
    return this.storage.get('providers', id);
  }

  async findProviderByBaseURL(baseURL) {
    const identity = providerIdentity(baseURL);
    const providers = await this.storage.list('providers');
    return providers.find((p) => p.identity === identity) ?? null;
  }

  /**
   * Upsert a provider by normalized baseURL. Returns { provider, created }.
   * Re-pasting the same URL never creates a second provider (test M).
   */
  async upsertProvider({ baseURL, name, protocol = 'openai-compatible', metadata = {} }) {
    const normalized = normalizeBaseURL(baseURL);
    if (!normalized) throw new Error(`Invalid provider baseURL: ${baseURL}`);
    const identity = providerIdentity(normalized);

    const existing = await this.findProviderByBaseURL(normalized);
    if (existing) {
      const merged = {
        ...existing,
        name: name ?? existing.name,
        metadata: { ...existing.metadata, ...metadata },
        updatedAt: isoNow(),
      };
      await this.storage.put('providers', merged);
      return { provider: merged, created: false };
    }

    const provider = {
      id: makeId('prv'),
      identity,
      name: name ?? providerNameFromURL(normalized),
      baseURL: normalized,
      protocol,
      status: STATUS.UNRESOLVED,
      createdAt: isoNow(),
      updatedAt: isoNow(),
      metadata: { ...metadata, discovered: false, verified: false },
    };
    await this.storage.put('providers', provider);
    return { provider, created: true };
  }

  async setProviderStatus(id, status, extra = {}) {
    const provider = await this.getProvider(id);
    if (!provider) return null;
    const updated = { ...provider, status, updatedAt: isoNow(), ...extra };
    await this.storage.put('providers', updated);
    return updated;
  }

  // ------------------------------------------------------------------- Models

  async listModels(providerId = null) {
    const models = await this.storage.list('models');
    return providerId ? models.filter((m) => m.providerId === providerId) : models;
  }

  async getModel(id) {
    return this.storage.get('models', id);
  }

  async findModel(providerId, modelId) {
    const identity = modelIdentity(providerId, modelId);
    const models = await this.storage.list('models');
    return models.find((m) => m.identity === identity) ?? null;
  }

  /** Upsert a model within a provider. `source` is pasted|discovered|imported (§3). */
  async upsertModel({ providerId, modelId, source = 'pasted', capabilities = {} }) {
    const cleanId = normalizeModelId(modelId);
    if (!cleanId) throw new Error('Empty modelId');
    const identity = modelIdentity(providerId, cleanId);

    const existing = await this.findModel(providerId, cleanId);
    if (existing) {
      const updated = {
        ...existing,
        source: existing.source === 'discovered' ? 'discovered' : source,
        capabilities: { ...existing.capabilities, ...capabilities },
        updatedAt: isoNow(),
      };
      await this.storage.put('models', updated);
      return { model: updated, created: false };
    }

    const model = {
      id: makeId('mdl'),
      identity,
      providerId,
      modelId: cleanId,
      source,
      status: STATUS.DISCOVERED,
      capabilities,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('models', model);
    return { model, created: true };
  }

  // --------------------------------------------------------------------- Keys

  async listKeys(providerId = null) {
    const keys = await this.storage.list('keys');
    return providerId ? keys.filter((k) => k.providerId === providerId) : keys;
  }

  async getKey(id) {
    return this.storage.get('keys', id);
  }

  async findKeyByFingerprint(providerId, fingerprint) {
    const keys = await this.storage.list('keys');
    return keys.find((k) => k.providerId === providerId && k.fingerprint === fingerprint) ?? null;
  }

  /**
   * Add a secret for a provider. Never creates a duplicate for the same
   * fingerprint (test L). Never deletes an existing key (§35).
   * Re-pasting an existing key just re-enables/updates it.
   */
  async upsertKey({ providerId, secret }) {
    const trimmed = String(secret ?? '').trim();
    if (!trimmed) throw new Error('Empty secret');
    const fingerprint = await fingerprintSecret(trimmed);

    const existing = await this.findKeyByFingerprint(providerId, fingerprint);
    if (existing) {
      // Keep the original secret; we never overwrite a secret in place (§22).
      const updated = { ...existing, enabled: true, updatedAt: isoNow() };
      await this.storage.put('keys', updated);
      return { key: updated, created: false };
    }

    const key = {
      id: makeId('key'),
      providerId,
      secret: trimmed,
      fingerprint,
      masked: maskSecret(trimmed),
      enabled: true,
      status: STATUS.UNRESOLVED,
      lastSuccessAt: null,
      lastFailureAt: null,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('keys', key);
    return { key, created: true };
  }

  async setKeyEnabled(id, enabled) {
    const key = await this.getKey(id);
    if (!key) return null;
    const updated = { ...key, enabled, updatedAt: isoNow() };
    await this.storage.put('keys', updated);
    return updated;
  }

  async setKeyStatus(id, status, extra = {}) {
    const key = await this.getKey(id);
    if (!key) return null;
    const updated = { ...key, status, updatedAt: isoNow(), ...extra };
    await this.storage.put('keys', updated);
    return updated;
  }

  // ----------------------------------------------------------------- Mappings

  async listMappings(filter = {}) {
    let mappings = await this.storage.list('mappings');
    if (filter.providerId) mappings = mappings.filter((m) => m.providerId === filter.providerId);
    if (filter.modelId) mappings = mappings.filter((m) => m.modelId === filter.modelId);
    if (filter.keyId) mappings = mappings.filter((m) => m.keyId === filter.keyId);
    if (filter.verified !== undefined) mappings = mappings.filter((m) => m.verified === filter.verified);
    return mappings;
  }

  async getMapping(id) {
    return this.storage.get('mappings', id);
  }

  async findMapping(providerId, modelId, keyId) {
    const identity = mappingIdentity(providerId, modelId, keyId);
    const mappings = await this.storage.list('mappings');
    return mappings.find((m) => m.identity === identity) ?? null;
  }

  /**
   * Create or update the Key x Model mapping record (§3).
   * This is the unit of health, cooldown and rotation.
   */
  async upsertMapping({ providerId, modelId, keyId, evidence = null, status = STATUS.UNRESOLVED }) {
    const identity = mappingIdentity(providerId, modelId, keyId);
    const existing = await this.findMapping(providerId, modelId, keyId);

    if (existing) {
      const updated = {
        ...existing,
        status: existing.verified ? existing.status : status,
        evidence: evidence ?? existing.evidence,
        updatedAt: isoNow(),
      };
      await this.storage.put('mappings', updated);
      return { mapping: updated, created: false };
    }

    const mapping = {
      id: makeId('map'),
      identity,
      providerId,
      modelId,
      keyId,
      status,
      verified: false,
      latencyMs: null,
      lastTestAt: null,
      lastSuccessAt: null,
      lastErrorClass: null,
      lastErrorMessage: null,
      cooldownUntil: null,
      failureCount: 0,
      score: 0,
      evidence,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('mappings', mapping);
    return { mapping, created: true };
  }

  async updateMapping(id, patch) {
    const mapping = await this.getMapping(id);
    if (!mapping) return null;
    const updated = { ...mapping, ...patch, updatedAt: isoNow() };
    await this.storage.put('mappings', updated);
    return updated;
  }

  // ------------------------------------------------------------- Unresolved Inbox

  async listUnresolved() {
    return this.storage.list('unresolved');
  }

  /**
   * Keep anything we could not map (§3, §23). Input is never discarded.
   * Same raw value dedupes on re-paste.
   */
  async addUnresolved({ raw, detectedType, candidates = [], meta = {} }) {
    const existing = (await this.storage.list('unresolved')).find(
      (u) => u.raw === raw && u.detectedType === detectedType
    );
    if (existing) {
      const merged = {
        ...existing,
        candidates: [...new Set([...existing.candidates, ...candidates])],
        meta: { ...existing.meta, ...meta },
        updatedAt: isoNow(),
      };
      await this.storage.put('unresolved', merged);
      return { item: merged, created: false };
    }

    const item = {
      id: makeId('unr'),
      raw,
      detectedType,
      status: STATUS.UNRESOLVED,
      candidates,
      meta,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('unresolved', item);
    return { item, created: true };
  }

  async removeUnresolved(id) {
    await this.storage.remove('unresolved', id);
  }

  // -------------------------------------------------------------------- Events

  /** Append a sanitized observability event (§31). Never stores full secrets. */
  async logEvent(event) {
    const record = {
      id: makeId('evt'),
      timestamp: isoNow(),
      ts: nowMs(),
      provider: event.provider ?? null,
      model: event.model ?? null,
      fingerprint: event.fingerprint ?? null,
      maskedKey: event.maskedKey ?? null,
      httpStatus: event.httpStatus ?? null,
      classification: event.classification ?? null,
      latencyMs: event.latencyMs ?? null,
      error: event.error ?? null,
      kind: event.kind ?? 'test',
    };
    await this.storage.put('events', record);
    return record;
  }

  async listEvents(limit = 100) {
    const events = await this.storage.list('events');
    return events.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // ------------------------------------------------------------- Import/Export

  async exportAll({ includeSecrets = false } = {}) {
    const [providers, models, keys, mappings, unresolved, events] = await Promise.all([
      this.storage.list('providers'),
      this.storage.list('models'),
      this.storage.list('keys'),
      this.storage.list('mappings'),
      this.storage.list('unresolved'),
      this.storage.list('events'),
    ]);

    const safeKeys = keys.map(({ secret, ...rest }) => ({
      ...rest,
      // §26: secrets are opt-in only, never exported by default.
      ...(includeSecrets ? { secret } : {}),
    }));

    return {
      version: 1,
      exportedAt: isoNow(),
      includesSecrets: Boolean(includeSecrets),
      providers,
      models,
      keys: safeKeys,
      mappings,
      unresolved,
      events: events.slice(0, 100),
    };
  }

  /** Merge import — dedupes, never blindly overwrites (§26). */
  async importAll(payload, { includeSecrets = false } = {}) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid import payload');

    const result = { providers: 0, models: 0, keys: 0, mappings: 0, unresolved: 0 };

    for (const provider of payload.providers ?? []) {
      const { provider: created, created: isNew } = await this.upsertProvider(provider);
      if (isNew) result.providers += 1;
      else await this.storage.put('providers', { ...created, ...provider });
    }

    const providerIdMap = new Map();
    for (const provider of await this.listProviders()) {
      providerIdMap.set(provider.identity, provider.id);
    }

    for (const model of payload.models ?? []) {
      const providerId = providerIdMap.get(providerIdentity(model.baseURL ?? '')) ?? model.providerId;
      if (!providerId) continue;
      const { created } = await this.upsertModel({ ...model, providerId, source: 'imported' });
      if (created) result.models += 1;
    }

    for (const key of payload.keys ?? []) {
      const providerId = providerIdMap.get(providerIdentity(key.baseURL ?? '')) ?? key.providerId;
      if (!providerId) continue;
      if (key.secret) {
        const { created } = await this.upsertKey({ providerId, secret: key.secret });
        if (created) result.keys += 1;
      } else if (key.fingerprint) {
        // Imported without secret: keep metadata, record as needing re-entry.
        await this.storage.put('keys', {
          ...key,
          id: key.id,
          providerId,
          enabled: false,
          status: STATUS.UNRESOLVED,
        });
      }
    }

    for (const mapping of payload.mappings ?? []) {
      const providerId = providerIdMap.get(providerIdentity(mapping.baseURL ?? '')) ?? mapping.providerId;
      if (!providerId) continue;
      const { created } = await this.upsertMapping({ ...mapping, providerId });
      if (created) result.mappings += 1;
    }

    for (const item of payload.unresolved ?? []) {
      const { created } = await this.addUnresolved(item);
      if (created) result.unresolved += 1;
    }

    return result;
  }
}
