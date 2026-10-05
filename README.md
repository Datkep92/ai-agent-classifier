# Smart AI API Registry + Router

Mobile-first web app. Paste **anything** — URLs, model names, API keys, JSON
configs, or a jumbled mix — and the system classifies it, discovers providers,
probes keys/models, maps everything, scores health, and routes requests with
automatic fallback.

Built from `plan(1).md`. Zero runtime dependencies, zero build step.

---

## Quick start

```sh
npm test          # run the full suite (87 tests)
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
index.html app.js styles.css   the UI (deployed from repository root)
tests/                 harness, mock fetch, cases A-O + security
```

The core has no DOM dependency, so it can run unchanged in Cloudflare
Workers, a Telegram bot, or an EXE.

---

## Buttons

| Button | What it does |
| --- | --- |
| `PHAN TICH + NHAP` | Classify and import whatever is in the paste box. |
| `TAI LAI MODEL` | Force-refresh every provider's `/models` list now. |
| `KIEM TRA TAT CA` | Probe every existing mapping. |
| `KIEM TRA NHANH` | Probe only starred models and mappings never tested. |
| `HUY` | Stop the current run, including the background startup sync. |

A star next to a model means "in use". Pasted models are starred
automatically; discovered models can be starred by tapping the star.
Stars survive export/import and drive what quick test covers.

On load, the tree renders from storage first, then every stored
provider refreshes its model list in the background. A provider whose
last successful fetch is under 30 minutes old is skipped, so opening
the page repeatedly does not re-download the same lists. The background
sync can be cancelled and never blocks the buttons.

## Rules it will not break

- Never marks a key dead because `/models` failed (inference may still work).
- Never treats every `429` as quota exhaustion — only when the body says so.
- Never disables a whole key because one model was denied.
- Never deletes a key. Never logs or exports a full secret by default.
- Never discards pasted input it could not classify — it lands in Unresolved.
- Never appends `/v1` without evidence; it is only tested as a candidate.
- Never attaches a pasted model to a provider that does not prove it.
  An attach needs a real inference PASS (with or without a key); a
  disproved guess is rolled back and the model stays parked.

## Running tests

```sh
npm test
```

87 tests: 15 mandatory plan cases (A-O), plus security/invariant checks,
key auto-scan, model attach, provider sync, and quick-test cases.
All network access is mocked — no real API calls.

The classifier benchmark is separate and repeatable:

```sh
node --no-experimental-fetch tests/bench-classifier.js
```

It scores URL / MODEL / API_KEY classification on real-world-shaped
inputs. Current standing: 71/71 overall — 14/14 API keys, 8/8 URLs,
5/5 unknown, 44/44 models.

Classification is structural, not keyword-based:

- A hostname's last dotted label must be alphabetic. That is what
  separates `api.anthropic.com` from `gemini-2.0-flash-exp`.
- A model id is composed of readable words (`sonnet`, `instruct`) and
  always has a separator. A random key blob has neither.
- A documented vendor key prefix wins over both, which is what keeps
  `ghp_...` or `sk_live_...` from reading as model names.

Because the corpus alone can be memorised, `tests/cases-classifier.js`
also asserts 56 held-out values that do not appear in the corpus.
