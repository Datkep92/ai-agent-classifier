import { getAdapter } from './adapters/openai-compatible.js';
import { STATUS } from './statuses.js';
import { CONFIG } from './config.js';
import { sanitizeError } from './util.js';

/**
 * Inference probe (§11).
 *
 * Request shape must be production-shaped, minimal tokens, with timeout and
 * latency measurement. A PASS here is the strongest evidence in the system
 * (§24) and outranks /models (§10).
 */

export async function probeMapping({
  registry,
  mapping,
  provider,
  model,
  key,
  adapter,
  maxTokens = CONFIG.probe.maxTokens,
} = {}) {
  const protocolAdapter = adapter ?? getAdapter(provider.protocol);
  const secrets = key?.secret ? [key.secret] : [];

  const result = await protocolAdapter.probeModel({
    baseURL: provider.baseURL,
    secret: key?.secret ?? null,
    model: model.modelId,
    timeoutMs: CONFIG.probeTimeoutMs,
    maxTokens,
  });

  const classification = result.classification ?? { status: STATUS.UNKNOWN_ERROR };
  const patch = {
    lastTestAt: new Date().toISOString(),
    latencyMs: result.latencyMs ?? null,
    lastErrorClass: classification.status,
    lastErrorMessage: result.ok ? null : sanitizeError(classification.message ?? '', secrets),
  };

  if (result.ok) {
    patch.status = STATUS.HEALTHY;
    patch.verified = true;
    patch.failureCount = 0;
    patch.cooldownUntil = null;
    patch.lastSuccessAt = new Date().toISOString();
    patch.evidence = 'inference';
  } else {
    patch.status = classification.status;
    patch.verified = false;
    // A failed probe increments failures but must not fabricate cooldown
    // here — health.js decides cooldown from status.
  }

  const updatedMapping = await registry.updateMapping(mapping.id, patch);

  // Key-level status only for key-scoped failures (§13, §35).
  if (key) {
    if (result.ok) {
      await registry.setKeyStatus(key.id, STATUS.HEALTHY, {
        lastSuccessAt: new Date().toISOString(),
      });
    } else if (classification.scope === 'key') {
      await registry.setKeyStatus(key.id, classification.status, {
        lastFailureAt: new Date().toISOString(),
      });
    }
    // NOTE: MODEL_DENIED deliberately does NOT touch key status (test I).
  }

  await registry.logEvent({
    kind: 'probe',
    provider: provider.name,
    model: model.modelId,
    fingerprint: key?.fingerprint ?? null,
    maskedKey: key?.masked ?? null,
    httpStatus: result.httpStatus ?? null,
    classification: classification.status,
    latencyMs: result.latencyMs ?? null,
    error: result.ok ? null : sanitizeError(classification.message ?? '', secrets),
  });

  return {
    ok: result.ok,
    mapping: updatedMapping,
    classification,
    latencyMs: result.latencyMs ?? null,
    content: result.content ?? null,
  };
}
