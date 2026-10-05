# Smart AI API Registry + Router

Mobile-first web app. Paste **anything** — URLs, model names, API keys, JSON
configs, or a jumbled mix — and the system classifies it, discovers providers,
probes keys/models, maps everything, scores health, and routes requests with
automatic fallback.

Built from `plan(1).md`. Zero runtime dependencies, zero build step.

---

## Quick start

```sh
npm test          # run the full suite (31 tests)
npm start         # serve the UI on http://localhost:8787
```

Open `http://localhost:8787` on your phone (the server prints a LAN URL).

For GitHub Pages, the app is already static: `index.html` + `app.js` +
`styles.css` + `core/`. No build, no bundler.

---

## How it works

```text
PASTE ANYTHING
     |
SMART INGEST      tokenize -> classify (URL / MODEL / API_KEY / JSON / UNKNOWN)
     |
NORMALIZE         fix /v1/v1, //chat/completions, trailing slashes
     |
REGISTRY          dedupe: provider by baseURL, key by fingerprint
     |
DISCOVERY         GET /models          (discovery — not proof of inference)
     |
PROBE             POST /chat/completions (inference — highest-confidence evidence)
     |
AUTO MAP          Key x Model mappings, scored and ranked
     |
HEALTH            status, cooldown, score, circuit breaker
     |
ROUTER            KEY -> MODEL -> PROVIDER with automatic fallback
```

## Layout

```text
core/
  ingest.js            smart paste parser
  classifier.js        item classification + confidence
  normalizer.js        URL normalization / dedupe keys
  discovery.js         GET /models
  probe.js             POST /chat/completions
  mapper.js            evidence-based auto-map, unresolved resolver
  registry.js          providers / models / keys / mappings / unresolved
  error-classifier.js  HTTP status + body -> status class
  health.js            score, cooldown, circuit breaker, recovery
  router.js            rotation and fallback
  test-engine.js       TEST KEY/MODEL/PROVIDER/ALL with concurrency + cancel
  pipeline.js          paste -> registry end-to-end
  storage.js           storage interface (IndexedDB / memory)
  config.js            all tunables in one place
  statuses.js          status enum and rotation rules
  util.js              fingerprint, mask, sanitize
  adapters/
    openai-compatible.js
    http.js
ui/                    source copy of the UI
index.html app.js styles.css   deployable root entry points
tests/                 harness, mock fetch, cases A-O + security
```

The core has no DOM dependency, so it can run unchanged in Cloudflare
Workers, a Telegram bot, or an EXE.

---

## Rules it will not break

- Never marks a key dead because `/models` failed (inference may still work).
- Never treats every `429` as quota exhaustion — only when the body says so.
- Never disables a whole key because one model was denied.
- Never deletes a key. Never logs or exports a full secret by default.
- Never discards pasted input it could not classify — it lands in Unresolved.
- Never appends `/v1` without evidence; it is only tested as a candidate.

## Running tests

```sh
npm test
```

31 tests: 15 mandatory plan cases (A-O) plus 9 security/invariant checks.
All network access is mocked — no real API calls.
