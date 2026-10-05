import { CONFIG } from '../config.js';

/**
 * Minimal fetch wrapper with timeout + latency measurement.
 * Uses only standard Web APIs so the same core runs on Node, Safari and
 * Cloudflare Workers (§28).
 */

export async function timedFetch(url, options = {}, timeoutMs = CONFIG.probeTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, latencyMs: Date.now() - startedAt, timedOut: false };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      response: null,
      latencyMs: Date.now() - startedAt,
      timedOut,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a body as JSON when possible, else raw text. Never throws. */
export async function readBody(response) {
  if (!response) return null;
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
