import {
  providerIdentity,
  modelIdentity,
  mappingIdentity,
  normalizeBaseURL,
  providerNameFromURL,
  normalizeModelId,
} from './normalizer.js';
import { STATUS, TERMINAL_STATUS } from './statuses.js';
import { fingerprintSecret, maskSecret, makeId, isoNow, nowMs } from './util.js';
import { CONFIG } from './config.js';

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
      // A model can arrive from two directions at once: the user pasted it
      // and discovery found it. Record both instead of letting the last
      // writer win, so "the user asked for this" is never lost (plan 25).
      const sources = [...new Set([...(existing.sources ?? [existing.source]), source])];
      const updated = {
        ...existing,
        source: sources.includes('discovered') ? 'discovered' : existing.source,
        sources,
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
      sources: [source],
      status: STATUS.DISCOVERED,
      capabilities,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('models', model);
    return { model, created: true };
  }

  /**
   * Delete a model. Used to undo a speculative attach: if we tried a provider
   * on a hunch and the probe disproved it, the row must not linger in the tree
   * as though the user had declared it there.
   */
  async removeModel(providerId, modelId) {
    const existing = await this.findModel(providerId, modelId);
    if (!existing) return false;
    await this.storage.remove('models', existing.id);
    return true;
  }

  /**
   * Attach a model to a provider on the user's explicit instruction (§7).
   *
   * Distinct from upsertModel: the caller is stating a fact ("this model
   * belongs to this URL") that no probe could have inferred, because the
   * provider does not advertise it. Recorded as source 'manual' so it stays
   * distinguishable from something that was discovered, and starred because
   * naming a model by hand is a statement of intent.
   *
   * When a probe is available it still runs against the provider's existing
   * keys. A hand-made mapping is not automatically healthy: the record has to
   * say whether the model actually answers.
   */
  async attachModel({ providerId, modelId, registry, probe = false } = {}) {
    const target = registry ?? this;
    const cleanId = normalizeModelId(modelId);
    if (!cleanId) throw new Error('Empty modelId');

    // Accept `true` as shorthand for "probe with the real prober": callers in
    // the UI should not have to import the probe module themselves.
    const prober =
      typeof probe === 'function'
        ? probe
        : probe
          ? await import('./probe.js').then((m) => m.probeMapping)
          : null;

    const { model, created } = await this.upsertModel({
      providerId,
      modelId: cleanId,
      source: 'manual',
      capabilities: { favourite: true },
    });

    // Mapping by hand is an explicit instruction to try this pairing, so any
    // earlier rejection of it is forgotten.
    const mapped = await this.getProvider(providerId);
    if (mapped?.identity) await this.clearRejectedModel(mapped.identity, model.modelId);

    if (!prober) return { model, created, probed: 0 };

    const provider = await this.getProvider(providerId);
    let probed = 0;
    for (const key of await this.listKeys(providerId)) {
      if (key.enabled === false) continue;
      const { mapping } = await this.upsertMapping({
        providerId,
        modelId: model.modelId,
        keyId: key.id,
        status: STATUS.UNRESOLVED,
      });
      if (!prober) continue;
      await prober({ registry: target, mapping, model, key, provider });
      probed += 1;
    }

    return { model, created, probed };
  }

  /**
   * Merge capabilities into a model WITHOUT touching provenance.
   *
   * `upsertModel` records where a model came from (source/sources). Starring a
   * model is not a provenance event — it must never make a discovered model
   * claim it was "pasted", or the tree would report a source the user never
   * gave. Also keeps discovery from clobbering a star set earlier.
   */
  async setModelCapabilities(providerId, modelId, capabilities = {}) {
    const existing = await this.findModel(providerId, modelId);
    if (!existing) return null;
    const updated = {
      ...existing,
      capabilities: { ...existing.capabilities, ...capabilities },
      updatedAt: isoNow(),
    };
    await this.storage.put('models', updated);
    return updated;
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

    // The user deleted this exact secret from this provider before. Honour
    // that decision instead of quietly restoring it on the next paste.
    if (await this.isKeyDeleted(providerId, fingerprint)) {
      return { key: null, created: false, blocked: true };
    }

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

  // ------------------------------------------- Remembered rejections (§7)
  //
  // A model that a provider has already refused must not be probed against it
  // again on every sweep. Without this, "TAI LAI MODEL" re-tests the whole
  // model x key surface each run, re-learning facts already established and
  // burning real requests on answers we already have.
  //
  // Keyed by provider identity + model id, never by secret: this is a claim
  // about the model, not about anyone's key.

  async recordRejectedModel(providerIdentity, modelId, reason = null) {
    const identity = `${providerIdentity}::${modelId}`;
    const existing = (await this.storage.list('rejectedModels')).find(
      (r) => r.identity === identity
    );
    if (existing) {
      const updated = { ...existing, reason, rejectedAt: isoNow() };
      await this.storage.put('rejectedModels', updated);
      return updated;
    }
    const record = {
      id: makeId('rej'),
      identity,
      providerIdentity,
      modelId,
      reason,
      rejectedAt: isoNow(),
    };
    await this.storage.put('rejectedModels', record);
    return record;
  }

  async listRejectedModels(providerIdentity = null) {
    const all = await this.storage.list('rejectedModels');
    return providerIdentity ? all.filter((r) => r.providerIdentity === providerIdentity) : all;
  }

  /** False when this provider has already refused this model. */
  async shouldProbeModel(providerIdentity, modelId) {
    const identity = `${providerIdentity}::${modelId}`;
    return !(await this.storage.list('rejectedModels')).some((r) => r.identity === identity);
  }

  /** True when this provider has already refused this model. */
  async isRememberedRejection(providerIdentity, modelId) {
    return !(await this.shouldProbeModel(providerIdentity, modelId));
  }

  /** Forget a rejection: the user asked for this pairing to be tried again. */
  async clearRejectedModel(providerIdentity, modelId) {
    const identity = `${providerIdentity}::${modelId}`;
    for (const record of await this.storage.list('rejectedModels')) {
      if (record.identity === identity) await this.storage.remove('rejectedModels', record.id);
    }
  }

  /**
   * Drop keys that reached a terminal state, and remember them by fingerprint.
   *
   * "Never deletes a key" is about not throwing away something that might work.
   * An EXPIRED or AUTH_INVALID key is the opposite: the provider said so. Left
   * in place it keeps generating mappings that fail the same way forever, so
   * pruning it is what actually stops the repeat scanning.
   *
   * Only terminal, key-scoped statuses qualify. A rate limit, a timeout or a
   * model denial is NOT the key's fault and must never evict it.
   */
  async pruneExpiredKeys({ now = Date.now(), statuses = TERMINAL_STATUS } = {}) {
    let pruned = 0;

    for (const key of await this.storage.list('keys')) {
      if (!statuses.has(key.status)) continue;

      // A quota that refills is not an expiry. Only statuses with no
      // self-healing path are pruned.
      if (
        key.status === STATUS.QUOTA_EXHAUSTED &&
        key.cooldownUntil &&
        Date.parse(key.cooldownUntil) > now
      ) {
        continue;
      }

      await this.removeKey(key.id);
      pruned += 1;
    }

    return pruned;
  }

  /**
   * Fingerprints the user has asked us to forget, per provider (§4, §35).
   *
   * "Never deletes a key" is the default, but it is the wrong rule when the
   * user explicitly deletes one: re-pasting the same secret would otherwise
   * bring it straight back and the delete would appear to do nothing.
   *
   * Only the non-reversible fingerprint is stored, never the secret itself,
   * so this list is safe to keep and safe to export.
   */
  async _rememberDeleted(providerId, fingerprint) {
    const store = await this.storage.list('deletedKeys');
    const identity = `${providerId}::${fingerprint}`;
    if (store.some((d) => d.identity === identity)) return;

    await this.storage.put('deletedKeys', {
      id: makeId('del'),
      identity,
      providerId,
      fingerprint,
      deletedAt: isoNow(),
    });
  }

  async isKeyDeleted(providerId, fingerprint) {
    const identity = `${providerId}::${fingerprint}`;
    return (await this.storage.list('deletedKeys')).some((d) => d.identity === identity);
  }

  async listDeletedKeys() {
    return this.storage.list('deletedKeys');
  }

  /**
   * Delete a key for good, with its mappings.
   *
   * Removes the secret from storage entirely and records the fingerprint so
   * the same secret cannot be silently re-imported on the next paste. Returns
   * false when the id is unknown so the UI can report honestly.
   */
  async removeKey(id) {
    const key = await this.getKey(id);
    if (!key) return false;

    // Mappings are the only other place the key id is referenced. Leaving
    // them behind would show rows in the tree with no key behind them.
    for (const mapping of await this.storage.list('mappings')) {
      if (mapping.keyId === id) await this.storage.remove('mappings', mapping.id);
    }

    await this._rememberDeleted(key.providerId, key.fingerprint);
    await this.storage.remove('keys', id);
    return true;
  }

  /** Undo a delete: the user changed their mind, so the key comes back. */
  async restoreKey(providerId, secret) {
    const trimmed = String(secret ?? '').trim();
    if (!trimmed) throw new Error('Empty secret');
    const fingerprint = await fingerprintSecret(trimmed);

    const identity = `${providerId}::${fingerprint}`;
    for (const record of await this.storage.list('deletedKeys')) {
      if (record.identity !== identity) continue;
      await this.storage.remove('deletedKeys', record.id);
    }

    const restored = await this.upsertKey({ providerId, secret: trimmed });

    // A key coming back is a fresh chance for its models, so clear the
    // rejections recorded against this provider.
    const owner = await this.getProvider(providerId);
    if (owner?.identity) {
      for (const record of await this.storage.list('rejectedModels')) {
        if (record.providerIdentity === owner.identity) {
          await this.storage.remove('rejectedModels', record.id);
        }
      }
    }

    return restored;
  }

  /**
   * Attach a secret to a provider on request (§7, §25).
   *
   * A key belongs to a URL, not to a model: one secret serves every model that
   * provider lists. The UI calls this when the user types a key into a URL, and
   * the caller then runs ensureMappings so the new key is immediately usable
   * across that URL's whole model list rather than one row at a time.
   *
   * Reports a reason instead of throwing, because every failure here is
   * something the user can correct: an empty box, a duplicate, or a key they
   * deleted earlier.
   */
  async addKeyToProvider({ providerId, secret }) {
    const trimmed = String(secret ?? '').trim();
    if (!trimmed) return { key: null, created: false, reason: 'EMPTY' };

    const provider = await this.getProvider(providerId);
    if (!provider) return { key: null, created: false, reason: 'NO_PROVIDER' };

    const { key, created, blocked } = await this.upsertKey({ providerId, secret: trimmed });
    if (blocked) return { key: null, created: false, reason: 'BLOCKED' };
    return { key, created, reason: created ? 'ADDED' : 'DUPLICATE' };
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

  /**
   * List mappings, optionally filtered.
   *
   * Accepts either a filter object or a bare providerId. The bare form was
   * easy to reach by mistake and silently ignored its argument, which returns
   * EVERY mapping instead of one provider's — a wrong-answer bug rather than
   * an error.
   */
  async listMappings(filter = {}) {
    const criteria = typeof filter === 'string' ? { providerId: filter } : filter ?? {};

    let mappings = await this.storage.list('mappings');
    if (criteria.providerId) {
      mappings = mappings.filter((m) => m.providerId === criteria.providerId);
    }
    if (criteria.modelId) mappings = mappings.filter((m) => m.modelId === criteria.modelId);
    if (criteria.keyId) mappings = mappings.filter((m) => m.keyId === criteria.keyId);
    if (criteria.verified !== undefined) {
      mappings = mappings.filter((m) => m.verified === criteria.verified);
    }
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
    // Bounded retention: keep the last N events instead of growing forever
    // (§31). Trim after write so the cap is always respected.
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
    await this._trimEvents();
    return record;
  }

  /** Drop the oldest events beyond the configured retention limit. */
  async _trimEvents() {
    const limit = CONFIG.eventLogLimit;
    const events = await this.storage.list('events');
    if (events.length <= limit) return;
    events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const excess = events.slice(0, events.length - limit);
    for (const event of excess) {
      await this.storage.remove('events', event.id);
    }
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
      // Keep the original source. Relabelling everything 'imported' erased the
      // distinction between a model the user mapped by hand and one that was
      // merely discovered somewhere else.
      const source = model.sources?.includes(model.source) ? model.source : model.source ?? 'imported';
      const { created } = await this.upsertModel({ ...model, providerId, source });
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
