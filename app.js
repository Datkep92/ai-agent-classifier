/**
 * UI layer. Contains NO business logic (plan 2).
 * Everything here is render + event wiring over the core modules.
 */
import { createStorage } from './core/storage.js';
import { Registry } from './core/registry.js';
import { Router } from './core/router.js';
import { TestEngine } from './core/test-engine.js';
import { importPaste } from './core/pipeline.js';
import { statusMeta, STATUS } from './core/statuses.js';
import { CONFIG } from './core/config.js';

const storage = createStorage(CONFIG.storage.driver);
const registry = new Registry(storage);
const router = new Router(registry);
const engine = new TestEngine(registry, { router });

let currentRun = null;

const $ = (id) => document.getElementById(id);
const treeRoot = $('treeRoot');
const inboxRoot = $('inboxRoot');
const logRoot = $('logRoot');
const pasteInput = $('pasteInput');

// ----------------------------------------------------------------- helpers

function log(message) {
  const line = document.createElement('div');
  line.textContent = message;
  logRoot.prepend(line);
  while (logRoot.childElementCount > 200) logRoot.lastElementChild.remove();
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function fmtCooldown(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + 's';
  return Math.ceil(s / 60) + 'm';
}

function severity(status) {
  if (status === 'HEALTHY') return 'ok';
  if (status === 'RATE_LIMITED' || status === 'TEMP_ERROR') return 'cool';
  if (['AUTH_INVALID', 'EXPIRED', 'QUOTA_EXHAUSTED'].includes(status)) return 'bad';
  return '';
}

// ------------------------------------------------------------------ render

function renderSummary(stats) {
  $('sHealthy').textContent = stats.healthy;
  $('sCool').textContent = stats.cooldown;
  $('sQuota').textContent = stats.quota;
  $('sInvalid').textContent = stats.invalid;
  $('sUnresolved').textContent = stats.unresolved;
}

function renderTree(providers, modelsByProvider, mappings, keysById) {
  treeRoot.replaceChildren();

  if (!providers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No providers yet. Paste a URL, model or key above.';
    treeRoot.append(empty);
    return;
  }

  for (const provider of providers) {
    const node = document.createElement('div');
    node.className = 'node';

    const row = document.createElement('div');
    row.className = 'row';

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▶';

    const name = document.createElement('div');
    name.className = 'name';
    const title = document.createElement('b');
    title.textContent = provider.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = provider.baseURL;
    name.append(title, sub);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = statusMeta(provider.status).emoji;

    const test = document.createElement('button');
    test.className = 'small';
    test.textContent = 'Test';
    test.addEventListener('click', (event) => {
      event.stopPropagation();
      testProvider(provider);
    });

    row.append(caret, name, badge, test);

    const children = document.createElement('div');
    children.className = 'children';

    const models = modelsByProvider.get(provider.id) ?? [];
    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No models discovered yet.';
      children.append(empty);
    }

    for (const model of models) {
      const modelNode = document.createElement('div');
      modelNode.className = 'node';

      const modelRow = document.createElement('div');
      modelRow.className = 'row';

      const mCaret = document.createElement('span');
      mCaret.className = 'caret';
      mCaret.textContent = '▶';

      const mName = document.createElement('div');
      mName.className = 'name';
      const mTitle = document.createElement('b');
      mTitle.textContent = model.modelId;
      mName.append(mTitle);

      const modelBadge = document.createElement('span');
      modelBadge.className = 'badge';
      const modelMappings = mappings.filter((m) => m.providerId === provider.id && m.modelId === model.modelId);
      const anyHealthy = modelMappings.some((m) => m.status === 'HEALTHY');
      modelBadge.textContent = anyHealthy ? '🟢' : statusMeta(modelMappings[0]?.status ?? 'DISCOVERED').emoji;

      modelRow.append(mCaret, mName, modelBadge);

      const modelChildren = document.createElement('div');
      modelChildren.className = 'children';

      if (!modelMappings.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No key mapped.';
        modelChildren.append(empty);
      }

      for (const mapping of modelMappings) {
        const key = keysById.get(mapping.keyId);
        const leaf = document.createElement('div');
        leaf.className = 'leaf';

        const dot = document.createElement('span');
        dot.className = 'badge';
        dot.textContent = statusMeta(mapping.status).emoji;

        const masked = document.createElement('span');
        masked.className = 'k';
        masked.textContent = key?.masked ?? 'unknown key';

        const cool = fmtCooldown(mapping.cooldownUntil);
        const pill = document.createElement('span');
        pill.className = 'pill ' + severity(mapping.status);
        pill.textContent = cool
          ? cool
          : mapping.latencyMs != null
            ? mapping.latencyMs + 'ms'
            : statusMeta(mapping.status).label;
        if (cool) pill.title = 'cooldown remaining';

        // TEST KEY (plan 20) plus a targeted Retry for this mapping only.
        const retry = document.createElement('button');
        retry.className = 'small';
        retry.textContent = '⟳';
        retry.title = 'Retry this mapping';
        retry.addEventListener('click', (event) => {
          event.stopPropagation();
          retryMapping(mapping, provider, key, model);
        });

        const info = document.createElement('button');
        info.className = 'small';
        info.textContent = '⋯';
        info.addEventListener('click', (event) => {
          event.stopPropagation();
          showError(mapping);
        });

        // TEST KEY action (plan 20) scoped to this provider's key.
        const testKeyBtn = document.createElement('button');
        testKeyBtn.className = 'small';
        testKeyBtn.textContent = 'T';
        testKeyBtn.title = 'Test this key against all its mappings';
        testKeyBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          testKeyNow(key.id);
        });

        const toggle = document.createElement('button');
        toggle.className = 'small';
        toggle.textContent = key?.enabled ? 'On' : 'Off';
        toggle.addEventListener('click', async (event) => {
          event.stopPropagation();
          await registry.setKeyEnabled(key.id, !key.enabled);
          toast(key.enabled ? 'Key disabled' : 'Key enabled');
          await refresh();
        });

        leaf.append(dot, masked, pill, testKeyBtn, retry, info, toggle);
        modelChildren.append(leaf);
      }

      modelNode.append(modelRow, modelChildren);
      modelRow.addEventListener('click', () => {
        modelNode.classList.toggle('open');
        mCaret.textContent = modelNode.classList.contains('open') ? '▼' : '▶';
      });

      children.append(modelNode);
    }

    node.append(row, children);
    row.addEventListener('click', () => {
      node.classList.toggle('open');
      caret.textContent = node.classList.contains('open') ? '▼' : '▶';
    });

    treeRoot.append(node);
  }
}

function renderInbox(items) {
  inboxRoot.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Inbox is empty.';
    inboxRoot.append(empty);
    return;
  }

  for (const item of items) {
    const box = document.createElement('div');
    box.className = 'item';

    const type = document.createElement('div');
    type.className = 'pill';
    type.textContent = item.detectedType;

    const raw = document.createElement('div');
    raw.className = 'raw';
    raw.textContent = item.raw;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      (item.meta?.reason ?? 'waiting') +
      (item.candidates?.length ? ' · candidates: ' + item.candidates.join(', ') : '');

    box.append(type, raw, meta);
    inboxRoot.append(box);
  }
}

function showError(mapping) {
  $('errText').textContent =
    mapping.lastErrorClass
      ? mapping.lastErrorClass + '\n\n' + (mapping.lastErrorMessage ?? '(no message)')
      : 'No error recorded for this mapping.';
  $('errDialog').showModal();
}

async function refresh() {
  const [providers, models, mappings, keys, unresolved] = await Promise.all([
    registry.listProviders(),
    registry.listModels(),
    registry.listMappings(),
    registry.listKeys(),
    registry.listUnresolved(),
  ]);

  const keysById = new Map(keys.map((k) => [k.id, k]));

  const modelsByProvider = new Map();
  for (const model of models) {
    if (!modelsByProvider.has(model.providerId)) modelsByProvider.set(model.providerId, []);
    modelsByProvider.get(model.providerId).push(model);
  }

  const stats = {
    healthy: mappings.filter((m) => m.status === 'HEALTHY').length,
    cooldown: mappings.filter((m) => m.status === 'RATE_LIMITED').length,
    quota: mappings.filter((m) => m.status === 'QUOTA_EXHAUSTED').length,
    invalid: mappings.filter((m) => ['AUTH_INVALID', 'EXPIRED'].includes(m.status)).length,
    unresolved: unresolved.length,
  };

  renderSummary(stats);
  renderTree(providers, modelsByProvider, mappings, keysById);
  renderInbox(unresolved);
}

// ------------------------------------------------------------------ actions

function setBusy(busy) {
  $('btnAnalyze').disabled = busy;
  $('btnTestAll').disabled = busy;
  $('btnCancel').hidden = !busy;
}

function onProgress(event) {
  const parts = [event.stage];
  if (event.provider) parts.push(event.provider);
  if (event.model) parts.push(event.model);
  if (event.maskedKey) parts.push(event.maskedKey);
  if (event.status) parts.push(event.status);
  if (event.latencyMs != null) parts.push(event.latencyMs + 'ms');
  log(parts.join(' · '));
}

async function analyze() {
  const raw = pasteInput.value.trim();
  if (!raw) {
    toast('Paste something first');
    return;
  }

  setBusy(true);
  currentRun = engine.createRun();
  log('— analyzing paste —');

  try {
    const report = await importPaste({
      registry,
      raw,
      run: currentRun,
      onProgress,
    });
    log(
      `import done: ${report.providersCount ?? 0} providers, ` +
        `${report.mappingsCount ?? 0} mappings, ${report.unresolved.length} unresolved`
    );
    pasteInput.value = '';
    toast('Import complete');
  } catch (error) {
    log('import error: ' + (error?.message ?? error));
    toast('Import failed');
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testProvider(provider) {
  setBusy(true);
  currentRun = engine.createRun();
  log('— testing ' + provider.name + ' —');
  try {
    const result = await engine.testProvider({
      providerId: provider.id,
      run: currentRun,
      onProgress,
    });
    log(`test ${provider.name}: ${result.pass ?? 0} pass / ${result.fail ?? 0} fail`);
  } catch (error) {
    log('test error: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function retryMapping(mapping, provider, key, model) {
  setBusy(true);
  currentRun = engine.createRun();
  log(`— retry ${provider.name}/${model.modelId} —`);
  try {
    const { probeMapping } = await import('./core/probe.js');
    const result = await probeMapping({ registry, mapping, provider, model, key });
    toast(result.ok ? 'Recovered' : result.classification.status);
  } catch (error) {
    log('retry error: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testFiltered(filter, label) {
  setBusy(true);
  currentRun = engine.createRun();
  log('— ' + (label || filter) + ' —');
  try {
    const summary = await engine.testAll({
      filter,
      run: currentRun,
      onProgress,
    });
    log(`${label || filter}: ${summary.pass} pass / ${summary.fail} fail`);
    toast(summary.fail ? `${summary.fail} failures` : 'Done');
  } catch (error) {
    log('test error: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testKeyNow(keyId) {
  setBusy(true);
  currentRun = engine.createRun();
  log('— testing key —');
  try {
    const result = await engine.testKey({ keyId, run: currentRun, onProgress });
    toast(result.ok ? 'Key works' : 'Key failed');
    log(`key test: ${result.ok ? 'ok' : 'failed'}`);
  } catch (error) {
    log('test error: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testAll() {
  setBusy(true);
  currentRun = engine.createRun();
  log('— test all —');
  try {
    const summary = await engine.testAll({
      filter: 'all',
      run: currentRun,
      onProgress,
    });
    log(
      `test all: ${summary.pass} pass / ${summary.fail} fail / ` +
        `${summary.skipped} skipped / ${summary.orphaned ?? 0} orphaned`
    );
    if (summary.orphaned) {
      toast(`${summary.orphaned} orphaned mapping(s) — re-import to repair`);
    }
    toast(summary.fail ? `Done with ${summary.fail} failures` : 'All healthy');
  } catch (error) {
    log('test error: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function exportJson() {
  // Secrets are never exported by default (plan 26).
  const payload = await registry.exportAll();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'smart-api-registry.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported (secrets excluded)');
}

async function importFile(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const result = await registry.importAll(payload);
    log(
      `imported: ${result.providers} providers, ${result.models} models, ` +
        `${result.keys} keys, ${result.mappings} mappings`
    );
    toast('Imported');
  } catch (error) {
    log('import file error: ' + (error?.message ?? error));
    toast('Import failed');
  } finally {
    await refresh();
  }
}

// -------------------------------------------------------------------- wiring

$('btnAnalyze').addEventListener('click', analyze);
$('btnTestAll').addEventListener('click', testAll);
$('btnRetry').addEventListener('click', () => testFiltered('failed'));
$('btnTestHealthy').addEventListener('click', () => testFiltered(STATUS.HEALTHY));
$('btnCancel').addEventListener('click', () => {
  currentRun?.cancel();
  toast('Cancelling…');
});
$('btnExport').addEventListener('click', exportJson);
$('btnImportFile').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) importFile(file);
  event.target.value = '';
});
$('errClose').addEventListener('click', () => $('errDialog').close());

if (location.protocol === 'file:') {
  $('corsBanner').hidden = false;
}

refresh().then(() => log('ready'));
