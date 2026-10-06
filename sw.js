/**
 * Update worker.
 *
 * GitHub Pages serves with `cache-control: max-age=600`, so a phone that opened
 * the app keeps running the old app.js and core modules for up to ten minutes
 * after a deploy, with no way to tell it is stale.
 *
 * This worker only serves the app-shell check: it keeps the newest files in a
 * cache and revalidates them. A changed file is picked up on the next load.
 * Nothing here ever caches an API response, and nothing is ever served stale
 * without being revalidated first.
 */
const CACHE = 'aai-registry-v1';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './core/classifier.js',
  './core/config.js',
  './core/discovery.js',
  './core/health.js',
  './core/ingest.js',
  './core/mapper.js',
  './core/normalizer.js',
  './core/pipeline.js',
  './core/probe.js',
  './core/registry.js',
  './core/router.js',
  './core/statuses.js',
  './core/storage.js',
  './core/test-engine.js',
  './core/util.js',
  './core/adapters/openai-compatible.js',
  './core/adapters/http.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never intercept provider API calls: they are cross-origin and must go
  // straight to the network, both for correctness and for CORS reasons.
  if (url.origin !== self.location.origin) return;

  // Network first, cache as the fallback. The user always gets the current
  // build when online, and the app still opens when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
