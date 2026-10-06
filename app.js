/**
 * UI layer. Contains NO business logic (plan 2).
 * Everything here is render + event wiring over the core modules.
 */
import { createStorage } from './core/storage.js';
import { Registry } from './core/registry.js';
import { Router } from './core/router.js';
import { TestEngine } from './core/test-engine.js';
import { importPaste, syncAllProviders } from './core/pipeline.js';
import { statusMeta, STATUS } from './core/statuses.js';
import { CONFIG } from './core/config.js';

const storage = createStorage(CONFIG.storage.driver);
const registry = new Registry(storage);
const router = new Router(registry);
const engine = new TestEngine(registry, { router });

let currentRun = null;

// Background startup sync keeps its own handle: it must be cancellable without
// taking ownership of the buttons that the user can already press.
let startupRun = null;

const $ = (id) => document.getElementById(id);
const treeRoot = $('treeRoot');
const inboxRoot = $('inboxRoot');
const logRoot = $('logRoot');
const pasteInput = $('pasteInput');


// ------------------------------------------------------------------ i18n
// Vietnamese labels for statuses and pipeline stages. The core keeps English
// enum values (they are machine-readable and exported); only display text is
// translated here.
const STATUS_VI = {
  HEALTHY: 'Khỏe',
  DISCOVERED: 'Đã quét',
  RATE_LIMITED: 'Bị giới hạn',
  QUOTA_EXHAUSTED: 'Hết quota',
  AUTH_INVALID: 'Key sai',
  EXPIRED: 'Hết hạn',
  MODEL_DENIED: 'Model bị chặn',
  PROVIDER_DOWN: 'Server lỗi',
  TEMP_ERROR: 'Lỗi tạm thời',
  REQUEST_ERROR: 'Request sai',
  UNKNOWN_ERROR: 'Lỗi chưa rõ',
  UNRESOLVED: 'Chưa xác định',
  DISABLED: 'Đã tắt',
};

const TYPE_VI = {
  URL: 'URL',
  MODEL: 'MODEL',
  API_KEY: 'KEY',
  JSON_CONFIG: 'JSON',
  UNKNOWN: 'CHƯA RÕ',
  UNKNOWN_TEXT: 'VĂN BẢN CHƯA RÕ',
};

const STAGE_VI = {
  provider: 'nhà cung cấp',
  discovery: 'quét model',
  connectivity: 'kết nối',
  inference: 'suy luận',
  'inference-done': 'xong suy luận',
  attempt: 'thử',
  success: 'thành công',
  failed: 'thất bại',
  abort: 'dừng',
  route: 'định tuyến',
  probe: 'thử',
};

function statusVi(status) {
  return STATUS_VI[status] ?? String(status ?? 'Chưa xác định');
}

function typeVi(type) {
  return TYPE_VI[type] ?? String(type ?? 'CHƯA RÕ');
}

function stageVi(stage) {
  return STAGE_VI[stage] ?? stage;
}

// Reasons attached to Unresolved items by the core. Translating them keeps
// the inbox readable without changing the stored English reason text.
const REASON_VI = {
  'no provider yet': 'chưa có nhà cung cấp nào',
  'no token was classifiable; original text kept verbatim':
    'không phân loại được token nào; giữ nguyên văn bản gốc',
  'nothing classifiable in input': 'không có gì phân loại được',
  'no confident match': 'không khớp mẫu nào',
  'url shape': 'có dạng URL',
  'known key prefix': 'có tiền tố key quen thuộc',
  'high-entropy opaque token': 'token trùng phân cấp cao',
  'model id shape': 'có dạng model id',
  'valid json object/array': 'JSON hợp lệ',
  'no provider accepted this key yet': 'chưa nhà cung cấp nào chấp nhận key này',
  'not listed by any provider; probe did not confirm':
    'không provider nào liệt kê; thử suy luận không xác nhận được',
  'waiting for provider': 'đang chờ nhà cung cấp',
};

function reasonVi(reason) {
  if (!reason) return null;
  if (REASON_VI[reason]) return REASON_VI[reason];
  // Preserve dynamic reasons such as "json key \"baseUrl\"" verbatim.
  return reason;
}

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

// ------------------------------------------------------------ status legend
//
// Colours were unexplained, so a red dot gave no idea whether to wait, fix
// the key, or delete it. Each entry states what was OBSERVED and the one
// action that actually changes it.
//
// `scope` matters as much as the colour: 'key' means the credential is the
// problem, 'mapping' means only this model+key pair is.

const LEGEND = [
  {
    emoji: '\u{1F7E2}',
    name: 'Khỏe',
    meaning: 'Gửi yêu cầu thật và provider trả lời được. Dùng được ngay.',
    act: 'Không cần làm gì',
  },
  {
    emoji: '\u{1F535}',
    name: 'Đã quét',
    meaning: 'URL trả về danh sách model, nhưng chưa gọi thử model nào.',
    act: 'Bấm KIỂM TRA để xác minh',
  },
  {
    emoji: '\u{1F7E0}',
    name: 'Chờ',
    meaning: 'Bị giới hạn tốc độ (429). Đã tự đặt hẹn giờ, hết giờ là thử lại.',
    act: 'Chờ, không cần động vào',
  },
  {
    emoji: '\u{1F7E3}',
    name: 'Hết quota',
    meaning: 'Key hết hạn mức dùng. Không phải lỗi key.',
    act: 'Nạp thêm hoặc đổi key',
  },
  {
    emoji: '\u{1F534}',
    name: 'Key sai',
    meaning: 'Provider từ chối key này. Thường là copy thiếu hoặc sai.',
    act: 'Sửa key, hoặc xoá nếu không dùng',
  },
  {
    emoji: '⚫',
    name: 'Hết hạn',
    meaning: 'Key đã hết hạn. Sẽ bị loại khỏi danh sách quét.',
    act: 'Dán key mới',
  },
  {
    emoji: '\u{1F7E1}',
    name: 'Model bị chặn',
    meaning: 'Key đúng nhưng không được phép dùng model này. Key vẫn dùng được với model khác.',
    act: 'Thử model khác',
  },
  {
    emoji: '\u{1F7E4}',
    name: 'Server lỗi',
    meaning: 'Provider không phản hồi hoặc lỗi phía họ. Không phải lỗi của bạn.',
    act: 'Chờ hoặc đổi URL',
  },
  {
    emoji: '\u{1F7E5}',
    name: 'Lỗi tạm thời',
    meaning: 'Timeout hoặc lỗi mạng. Thường tự khỏi.',
    act: 'Thử lại',
  },
  {
    emoji: '⚪',
    name: 'Lỗi chưa rõ',
    meaning: 'Provider trả lỗi lạ, không khớp mẫu nào đã biết.',
    act: 'Bấm ⋯ để xem chi tiết',
  },
  {
    emoji: '❓',
    name: 'Chưa xác định',
    meaning: 'Chưa biết thuộc URL nào, hoặc chưa kiểm tra được.',
    act: 'Gán thủ công, hoặc kiểm tra lại',
  },
  {
    emoji: '⏸️',
    name: 'Đã tắt',
    meaning: 'Bạn đã tắt key này. Vẫn còn, chỉ không quét.',
    act: 'Bấm Bật để dùng lại',
  },
];

function renderLegend() {
  const root = $('legendRoot');
  if (!root) return;
  root.replaceChildren();

  for (const entry of LEGEND) {
    const row = document.createElement('div');
    row.className = 'legend-row';

    const emoji = document.createElement('span');
    emoji.className = 'e';
    emoji.textContent = entry.emoji;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    const meaning = document.createElement('span');
    meaning.className = 'mean';
    meaning.textContent = entry.meaning;

    const act = document.createElement('span');
    act.className = 'act';
    act.textContent = '→ ' + entry.act;

    row.append(emoji, name, meaning, act);
    root.append(row);
  }
}

function renderSummary(stats) {
  $('sHealthy').textContent = stats.healthy;
  $('sCool').textContent = stats.cooldown;
  $('sQuota').textContent = stats.quota;
  $('sInvalid').textContent = stats.invalid;
  $('sUnresolved').textContent = stats.unresolved;
}

function renderTree(providers, modelsByProvider, mappings, keysById, deletedCount = new Map()) {
  treeRoot.replaceChildren();

  if (!providers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Chưa có nhà cung cấp nào. Hãy dán URL, model hoặc key ở trên.';
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

    const deleted = deletedCount.get(provider.id) ?? 0;
    if (deleted) {
      const gone = document.createElement('div');
      gone.className = 'sub';
      gone.textContent = deleted + ' key đã xoá';
      gone.style.color = 'var(--danger)';
      sub.after(gone);
    }

    name.append(title, sub);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = statusMeta(provider.status).emoji;

    const test = document.createElement('button');
    test.className = 'small';
    test.textContent = 'Kiểm tra';
    test.addEventListener('click', (event) => {
      event.stopPropagation();
      testProvider(provider);
    });

    // A key belongs to the URL, so this lives on the URL row: one key is
    // applied to every model underneath, not attached model by model.
    const addKey = document.createElement('button');
    addKey.className = 'small';
    addKey.textContent = '+ Key';
    addKey.title = 'Thêm API key cho URL này, dùng cho mọi model';
    addKey.addEventListener('click', (event) => {
      event.stopPropagation();
      openKeyDialog(provider);
    });

    row.append(caret, name, badge, addKey, test);

    const children = document.createElement('div');
    children.className = 'children';

    const models = modelsByProvider.get(provider.id) ?? [];
    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Chưa phát hiện model nào.';
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
      const anyHealthy = modelMappings.some((m) => m.status === STATUS.HEALTHY);
      const probedStatus =
        modelMappings[0]?.status ?? model.anonymousProbe?.status ?? 'DISCOVERED';
      modelBadge.textContent = anyHealthy
        ? '🟢'
        : statusMeta(probedStatus).emoji;
      if (model.anonymousProbe) {
        modelBadge.title = model.anonymousProbe.needsKey
          ? 'Chưa xác minh được — cần key'
          : 'Đã kiểm tra bằng probe thật';
      }

      // Favourite toggle. Marking a model in use is what "quick test" targets,
      // and it survives export/import via capabilities.
      const star = document.createElement('button');
      star.className = 'small star' + (model.capabilities?.favourite ? ' on' : '');
      star.textContent = model.capabilities?.favourite ? '\u2605' : '\u2606';
      star.title = model.capabilities?.favourite
        ? 'Đang dùng \u2014 bỏ dấu'
        : 'Đánh dấu đang dùng';
      star.addEventListener('click', async (event) => {
        event.stopPropagation();
        const next = !model.capabilities?.favourite;
        // Capabilities only. Going through upsertModel would record this as a
        // "pasted" source and make a discovered model claim the user named it.
        await registry.setModelCapabilities(provider.id, model.modelId, { favourite: next });
        await refresh();
      });

      modelRow.append(mCaret, mName, star, modelBadge);

      const modelChildren = document.createElement('div');
      modelChildren.className = 'children';

      if (!modelMappings.length) {
        // No key yet: show the anonymous probe verdict so the tree still
        // reports whether this model genuinely answers.
        const probeInfo = model.anonymousProbe;
        if (probeInfo) {
          const leaf = document.createElement('div');
          leaf.className = 'leaf';

          const dot = document.createElement('span');
          dot.className = 'badge';
          dot.textContent = statusMeta(probeInfo.status).emoji;

          const name = document.createElement('span');
          name.className = 'k';
          name.textContent = probeInfo.needsKey
            ? 'Cần key để xác minh'
            : 'Đã kiểm tra không cần key';

          const pill = document.createElement('span');
          pill.className = 'pill ' + severity(probeInfo.status);
          pill.textContent =
            probeInfo.latencyMs != null ? probeInfo.latencyMs + 'ms' : statusVi(probeInfo.status);

          leaf.append(dot, name, pill);
          modelChildren.append(leaf);
        } else {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'Chưa gán key nào.';
          modelChildren.append(empty);
        }
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
        // Masked by default; the full secret is only rendered on an explicit
        // per-key tap and is never written to the log (plan 4, 31).
        masked.textContent = key?.masked ?? 'chưa rõ';
        if (key?.secret) {
          masked.classList.add('revealable');
          masked.addEventListener('click', () => {
            const shown = masked.dataset.shown === '1';
            masked.textContent = shown ? key.masked : key.secret;
            masked.dataset.shown = shown ? '0' : '1';
            masked.classList.toggle('revealed', !shown);
          });
          // Long press copies the full key. Clipboard is the only way to get
          // it out of a phone UI without reading it aloud.
          let pressTimer = null;
          masked.addEventListener('touchstart', () => {
            pressTimer = setTimeout(() => {
              navigator.clipboard?.writeText(key.secret).then(
                () => toast('Đã chép API key'),
                () => toast('Không chép được')
              );
            }, 550);
          }, { passive: true });
          const clearPress = () => clearTimeout(pressTimer);
          masked.addEventListener('touchend', clearPress);
          masked.addEventListener('touchmove', clearPress);
          masked.title = 'Chạm để hiện / ẩn · giữ để chép';
        }

        const cool = fmtCooldown(mapping.cooldownUntil);
        const pill = document.createElement('span');
        pill.className = 'pill ' + severity(mapping.status);
        pill.textContent = cool
          ? cool
          : mapping.latencyMs != null
            ? mapping.latencyMs + 'ms'
            : statusVi(mapping.status);
        if (cool) pill.title = 'thời gian chờ còn lại';

        // TEST KEY (plan 20) plus a targeted Retry for this mapping only.
        const retry = document.createElement('button');
        retry.className = 'small';
        retry.textContent = '⟳';
        retry.title = 'Thử lại mapping này';
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
        testKeyBtn.title = 'Kiểm tra key này với toàn bộ mapping';
        testKeyBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          testKeyNow(key.id);
        });

        const toggle = document.createElement('button');
        toggle.className = 'small';
        toggle.textContent = key?.enabled ? 'Bật' : 'Tắt';
        toggle.addEventListener('click', async (event) => {
          event.stopPropagation();
          await registry.setKeyEnabled(key.id, !key.enabled);
          toast(key.enabled ? 'Đã tắt key' : 'Đã bật key');
          await refresh();
        });

        // Delete the key for good. Remembers the fingerprint so the same
        // secret cannot come back on the next paste.
        const del = document.createElement('button');
        del.className = 'small danger';
        del.textContent = '\u2715';
        del.title = 'Xoá API key này khỏi URL';
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          openDeleteDialog(key, provider);
        });

        leaf.append(dot, masked, pill, testKeyBtn, retry, info, toggle, del);
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
    empty.textContent = 'Hộp thư đang trống.';
    inboxRoot.append(empty);
    return;
  }

  for (const item of items) {
    const box = document.createElement('div');
    box.className = 'item';

    const type = document.createElement('div');
    type.className = 'pill';
    type.textContent = typeVi(item.detectedType);

    const raw = document.createElement('div');
    raw.className = 'raw';
    raw.textContent = item.raw;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      (reasonVi(item.meta?.reason) ?? 'đang chờ') +
      (item.candidates?.length ? ' · candidates: ' + item.candidates.join(', ') : '');

    box.append(type, raw, meta);

    // An unidentified MODEL can always be settled by hand. This is the escape
    // hatch for the case no probe can resolve: the provider does not advertise
    // the model, but the user knows it works.
    if (item.detectedType === 'MODEL') {
      const pick = document.createElement('button');
      pick.className = 'small';
      pick.textContent = 'Gán thủ công';
      pick.addEventListener('click', () => openMapDialog(item.raw));
      box.append(pick);
    }
    inboxRoot.append(box);
  }
}

function showError(mapping) {
  $('errText').textContent =
    mapping.lastErrorClass
      ? mapping.lastErrorClass + '\n\n' + (mapping.lastErrorMessage ?? '(no message)')
      : 'Mapping này chưa ghi nhận lỗi nào.';
  $('errDialog').showModal();
}

// ------------------------------------------------------------ filtering
//
// The tree can get long, so the chips narrow it. Filtering happens on the
// RENDER path only: nothing is deleted or hidden from the registry, so
// switching back to "all" always shows the true state.

const FILTERS = {
  all: () => true,
  healthy: (m) => m.status === STATUS.HEALTHY,
  // "Broken" means the credential itself failed, not a model denial or a
  // rate limit: those are not the key's fault.
  broken: (m) =>
    [STATUS.AUTH_INVALID, STATUS.EXPIRED, STATUS.QUOTA_EXHAUSTED, STATUS.PROVIDER_DOWN].includes(m.status),
  pending: (m) =>
    [STATUS.RATE_LIMITED, STATUS.TEMP_ERROR, STATUS.UNRESOLVED, STATUS.DISCOVERED].includes(m.status),
  unresolved: (m) => !m.lastTestAt,
};

let activeFilter = 'all';

function applyFilter(filter) {
  activeFilter = FILTERS[filter] ? filter : 'all';
  for (const chip of document.querySelectorAll('.chip')) {
    chip.classList.toggle('on', chip.dataset.filter === activeFilter);
  }
  refresh();
}

// ------------------------------------------------- detail dialog (copyable)
// One bucket per chip: clicking "Khỏe" shows every URL / model / key that is
// healthy. Each value is individually copyable, because the usual next step
// after seeing this list is to paste it somewhere else.

let detailLines = [];

function collectDetail(filter) {
  const matches = FILTERS[filter] ?? FILTERS.all;

  return registry.listMappings().then((mappings) =>
    Promise.all([registry.listProviders(), registry.listKeys(), registry.listModels()]).then(
      ([providers, keys, models]) => {
        const providerById = new Map(providers.map((p) => [p.id, p]));
        const keyById = new Map(keys.map((k) => [k.id, k]));
        const modelByKey = new Map(models.map((m) => [`${m.providerId}::${m.modelId}`, m]));

        const lines = [];
        for (const mapping of mappings) {
          if (!matches(mapping)) continue;
          const provider = providerById.get(mapping.providerId);
          const key = keyById.get(mapping.keyId);
          const model = modelByKey.get(`${mapping.providerId}::${mapping.modelId}`);
          lines.push({
            url: provider?.baseURL ?? '(không rõ)',
            model: model?.modelId ?? mapping.modelId,
            // Full secret for copy: the user asked for this list to be usable.
            // Copy is an explicit act, unlike the tree where it stays masked.
            key: key?.secret ?? '(không có key)',
            status: mapping.status,
            mappingId: mapping.id,
            keyId: mapping.keyId,
            providerId: mapping.providerId,
          });
        }
        return lines;
      }
    )
  );
}

async function openDetail(filter) {
  const lines = await collectDetail(filter);
  detailLines = lines;

  $('detailTitle').textContent = {
    all: 'Tất cả',
    healthy: 'Khỏe',
    broken: 'Hỏng',
    pending: 'Chờ',
    unresolved: 'Chưa từng kiểm tra',
  }[filter] ?? 'Chi tiết';

  $('detailSub').textContent =
    lines.length + ' dòng · chạm để chép từng giá trị, hoặc chép tất cả';

  const rows = $('detailRows');
  rows.replaceChildren();

  if (!lines.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Không có dòng nào khớp bộ lọc này.';
    rows.append(empty);
    $('detailDialog').showModal();
    return;
  }

  for (const line of lines) {
    const box = document.createElement('div');
    box.className = 'row-item';

    for (const [label, value] of [
      ['url', line.url],
      ['model', line.model],
      ['api', line.key],
    ]) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = label;

      const valueEl = document.createElement('span');
      valueEl.className = 'k';
      valueEl.textContent = value;
      valueEl.title = 'Chạm để chép';
      valueEl.addEventListener('click', () => {
        navigator.clipboard?.writeText(value).then(
          () => toast('Đã chép ' + label),
          () => toast('Không chép được')
        );
      });

      box.append(tag, valueEl);
    }

    // Deleting a key is offered right where the user sees it is broken, so a
    // dead credential never keeps being re-scanned in the background.
    if (line.keyId) {
      const del = document.createElement('button');
      del.className = 'small danger';
      del.textContent = '\u2715';
      del.title = 'Loại key này khỏi danh sách quét';
      del.addEventListener('click', async () => {
        const ok = await registry.removeKey(line.keyId);
        toast(ok ? 'Đã loại key' : 'Key không tồn tại');
        $('detailDialog').close();
        await refresh();
      });
      box.append(del);
    }

    rows.append(box);
  }

  $('detailDialog').showModal();
}

async function copyAllDetail() {
  const text = detailLines
    .map((l) => `${l.url}\n${l.model}\n${l.key}`)
    .join('\n---\n');

  navigator.clipboard?.writeText(text).then(
    () => toast('Đã chép ' + detailLines.length + ' dòng'),
    () => toast('Không chép được')
  );
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

  // Per-provider count of keys the user deleted, so the action stays visible
  // after the row itself is gone.
  const deletedCount = new Map();
  for (const record of await registry.listDeletedKeys()) {
    deletedCount.set(record.providerId, (deletedCount.get(record.providerId) ?? 0) + 1);
  }

  const modelsByProvider = new Map();
  for (const model of models) {
    if (!modelsByProvider.has(model.providerId)) modelsByProvider.set(model.providerId, []);
    modelsByProvider.get(model.providerId).push(model);
  }

  const matches = FILTERS[activeFilter] ?? FILTERS.all;
  const shown = mappings.filter(matches);

  $('filterCount').textContent =
    activeFilter === 'all'
      ? mappings.length + ' mapping'
      : shown.length + ' / ' + mappings.length + ' mapping đang lọc';

  const stats = {
    healthy: mappings.filter((m) => m.status === 'HEALTHY').length,
    cooldown: mappings.filter((m) => m.status === 'RATE_LIMITED').length,
    quota: mappings.filter((m) => m.status === 'QUOTA_EXHAUSTED').length,
    invalid: mappings.filter((m) => ['AUTH_INVALID', 'EXPIRED'].includes(m.status)).length,
    unresolved: unresolved.length,
  };

  renderSummary(stats);
  renderTree(providers, modelsByProvider, shown, keysById, deletedCount);
  renderInbox(unresolved);
}

// ------------------------------------------------------------------ actions

function setCancelVisible(visible) {
  $('btnCancel').hidden = !visible;
}

function setBusy(busy) {
  for (const id of [
    'btnAnalyze',
    'btnTestAll',
    'btnTestQuick',
    'btnSync',
    'btnRetry',
    'btnTestHealthy',
  ]) {
    $(id).disabled = busy;
  }
  // A foreground action hides the button only when nothing else is running.
  setCancelVisible(busy || Boolean(startupRun));
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
    toast('Hãy dán nội dung trước đã');
    return;
  }

  setBusy(true);
  currentRun = engine.createRun();
  log('— đang phân tích nội dung dán —');

  try {
    const report = await importPaste({
      registry,
      raw,
      run: currentRun,
      onProgress,
    });
    log(
      `đã nhập: ${report.providersCount ?? 0} nhà cung cấp, ` +
        `${report.mappingsCount ?? 0} mapping, ${report.unresolved.length} chưa xác định`
    );
    pasteInput.value = '';
    toast('Đã nhập xong');
  } catch (error) {
    log('lỗi nhập: ' + (error?.message ?? error));
    toast('Nhập thất bại');
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testProvider(provider) {
  setBusy(true);
  currentRun = engine.createRun();
  log('— đang kiểm tra ' + provider.name + ' —');
  try {
    const result = await engine.testProvider({
      providerId: provider.id,
      run: currentRun,
      onProgress,
    });
    log(`kiểm tra ${provider.name}: ${result.pass ?? 0} đạt / ${result.fail ?? 0} lỗi`);
  } catch (error) {
    log('lỗi kiểm tra: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

// ------------------------------------------------- manual mapping (plan 7)
// The case no probe can settle: the provider does not advertise this model,
// but the user knows it belongs there. We attach it and then PROBE, so the
// record says whether it really answers instead of merely that it was asked.

let mapSource = null;

// ------------------------------------------------ add a key to one URL
//
// A key belongs to a provider, not to a model: one secret serves every model
// that URL lists. So the action is "add a key to this URL" and the system
// builds the mappings for all of that URL's models by itself.

async function openKeyDialog(provider) {
  $('keyHint').textContent = provider.name + ' — ' + provider.baseURL;
  $('keySecret').value = '';
  $('keyDialog').dataset.providerId = provider.id;
  $('keyDialog').showModal();
  $('keySecret').focus();
}

async function confirmAddKey() {
  const providerId = $('keyDialog').dataset.providerId;
  const secret = $('keySecret').value.trim();
  if (!providerId || !secret) {
    toast('Dán key vào trước đã');
    return;
  }

  setBusy(true);
  currentRun = engine.createRun();
  try {
    const result = await registry.addKeyToProvider({ providerId, secret });

    if (result.reason === 'BLOCKED') {
      log('key này đã bị xoá khỏi URL, không thêm lại');
      toast('Key đã xoá trước đó — không thêm lại');
      $('keyDialog').close();
      return;
    }
    if (result.reason === 'DUPLICATE') {
      toast('URL này đã có key này rồi');
      $('keyDialog').close();
      return;
    }

    // One key, every model: build the mappings rather than asking the user to
    // attach it model by model.
    const built = await engine.ensureMappings();
    const models = (await registry.listModels(providerId)).length;

    log(
      `đã thêm key vào ${result.key.masked} · ${built} mapping ` +
        `cho ${models} model của URL này`
    );
    toast(`Đã áp cho ${models} model`);
    $('keyDialog').close();
    $('keySecret').value = '';
  } catch (error) {
    log('lỗi thêm key: ' + (error?.message ?? error));
    toast('Thêm key lỗi');
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function openMapDialog(modelId) {
  const providers = await registry.listProviders();
  if (!providers.length) {
    toast('Chưa có URL nào để gắn');
    return;
  }

  mapSource = modelId;
  $('mapHint').textContent = 'Gắn "' + modelId + '" vào URL bạn chọn.';
  $('mapModel').value = modelId;

  const select = $('mapProvider');
  select.replaceChildren();
  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name + ' — ' + provider.baseURL;
    select.append(option);
  }

  $('mapDialog').showModal();
  $('mapModel').focus();
}

async function confirmManualMap() {
  const modelId = $('mapModel').value.trim();
  const providerId = $('mapProvider').value;
  if (!modelId || !providerId) {
    toast('Cần tên model và URL');
    return;
  }

  setBusy(true);
  currentRun = engine.createRun();
  log('— gán thủ công: ' + modelId + ' —');
  try {
    const { model, created, probed } = await registry.attachModel({
      providerId,
      modelId,
      probe: true,
    });

    // The item came out of the inbox; a manual attach settles it.
    for (const item of await registry.listUnresolved()) {
      if (item.detectedType === 'MODEL' && item.raw === modelId) {
        await registry.removeUnresolved(item.id);
      }
    }

    log(
      `đã gắn ${model.modelId}${created ? ' (mới)' : ' (đã có)'}` +
        (probed ? ` · ${probed} probe` : ' · chưa có key để probe')
    );
    toast(probed ? 'Đã gán và kiểm tra' : 'Đã gán');
    $('mapDialog').close();
  } catch (error) {
    log('lỗi gán: ' + (error?.message ?? error));
    toast('Gán lỗi');
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

// ------------------------------------------------------ deleting a key (§4)
// Deleting is remembered by fingerprint, so re-pasting the same secret cannot
// quietly bring it back. Only the fingerprint is stored, never the secret.

async function openDeleteDialog(key, provider) {
  $('delHint').textContent =
    provider.name + ' — ' + (key?.masked ?? provider.baseURL);

  $('delSecret').value = key?.secret ?? '';
  $('delSecret').placeholder = key?.secret
    ? 'đã điền sẵn'
    : 'dán lại key để khôi phục';
  $('delSecretLabel').textContent = key
    ? 'Key đã xoá (để khôi phục)'
    : 'Key đã xoá khỏi URL này';

  // Hide the delete button once there is nothing left to delete.
  $('delConfirm').hidden = !key;
  $('delRestore').hidden = Boolean(key);

  $('delDialog').dataset.providerId = provider.id;
  $('delDialog').dataset.keyId = key?.id ?? '';
  $('delDialog').showModal();
  $('delSecret').focus();
}

async function confirmDeleteKey() {
  const providerId = $('delDialog').dataset.providerId;
  const keyId = $('delDialog').dataset.keyId;
  if (!providerId || !keyId) return;

  const ok = await registry.removeKey(keyId);
  log(ok ? 'đã xoá key' : 'không tìm thấy key để xoá');
  toast(ok ? 'Đã xoá key' : 'Key không tồn tại');
  $('delDialog').close();
  await refresh();
}

async function confirmRestoreKey() {
  const providerId = $('delDialog').dataset.providerId;
  const secret = $('delSecret').value.trim();
  if (!secret || !providerId) {
    toast('Dán lại key để khôi phục');
    return;
  }

  setBusy(true);
  try {
    const { key } = await registry.restoreKey(providerId, secret);
    log('đã khôi phục key');
    toast(key ? 'Đã khôi phục' : 'Không khôi phục được');
    $('delDialog').close();
  } catch (error) {
    log('lỗi khôi phục: ' + (error?.message ?? error));
    toast('Khôi phục lỗi');
  } finally {
    setBusy(false);
    await refresh();
  }
}


async function retryMapping(mapping, provider, key, model) {
  setBusy(true);
  currentRun = engine.createRun();
  log(`— thử lại ${provider.name}/${model.modelId} —`);
  try {
    const { probeMapping } = await import('./core/probe.js');
    const result = await probeMapping({ registry, mapping, provider, model, key });
    toast(result.ok ? 'Đã khỏi' : result.classification.status);
  } catch (error) {
    log('lỗi thử lại: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function syncModels({ force = false } = {}) {
  setBusy(true);
  currentRun = engine.createRun();
  log('— tải lại danh sách model —');
  try {
    const summary = await syncAllProviders({
      registry,
      run: currentRun,
      force,
      onProgress: (e) => log(`tải ${e.position}/${e.total} · ${e.provider}`),
    });
    if (summary.cancelled) {
      log('tải model đãng bị huỷ');
      return;
    }
    log(
      `xong: ${summary.providers} provider · +${summary.modelsAdded} model · ` +
        `${summary.failed} lỗi · ${summary.resolved} mốc được gắn` +
        `${summary.skipped ? `bỏ qua ${summary.skipped} provider còn mới` : ''}`
    );
    const gained = summary.modelsAdded + summary.resolved;
    toast(gained ? `+${gained} mốc mới` : 'Không có mốc mới');
  } catch (error) {
    log('lỗi tải model: ' + (error?.message ?? error));
    toast('Tải model lỗi');
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testQuick() {
  setBusy(true);
  currentRun = engine.createRun();
  log('— kiểm tra nhanh —');
  try {
    const summary = await engine.testAll({
      filter: 'quick',
      run: currentRun,
      onProgress,
    });
    log(`kiểm tra nhanh: ${summary.pass} đạt / ${summary.fail} lỗi / ${summary.skipped} bỏ qua`);
    toast(summary.fail ? `${summary.fail} lỗi` : 'Xong');
  } catch (error) {
    log('lỗi kiểm tra nhanh: ' + (error?.message ?? error));
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
    toast(summary.fail ? `${summary.fail} lỗi` : 'Xong');
  } catch (error) {
    log('lỗi kiểm tra: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testKeyNow(keyId) {
  setBusy(true);
  currentRun = engine.createRun();
  log('— đang kiểm tra key —');
  try {
    const result = await engine.testKey({ keyId, run: currentRun, onProgress });
    toast(result.ok ? 'Key hoạt động' : 'Key lỗi');
    log(`kiểm tra key: ${result.ok ? 'đạt' : 'lỗi'}`);
  } catch (error) {
    log('lỗi kiểm tra: ' + (error?.message ?? error));
  } finally {
    setBusy(false);
    currentRun = null;
    await refresh();
  }
}

async function testAll() {
  setBusy(true);
  currentRun = engine.createRun();
  log('— kiểm tra tất cả —');
  try {
    const summary = await engine.testAll({
      filter: 'all',
      run: currentRun,
      onProgress,
    });
    log(
      `kiểm tra tất cả: ${summary.pass} đạt / ${summary.fail} lỗi / ` +
        `${summary.skipped} bỏ qua / ${summary.orphaned ?? 0} mồ côi`
    );
    if (summary.orphaned) {
      toast(`${summary.orphaned} mapping mồ côi — nhập lại để sửa`);
    }
    toast(summary.fail ? `Xong, còn ${summary.fail} lỗi` : 'Tất cả khỏe');
  } catch (error) {
    log('lỗi kiểm tra: ' + (error?.message ?? error));
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
  toast('Đã xuất (không kèm secret)');
}

async function importFile(file) {
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const result = await registry.importAll(payload);
    log(
      `đã nhập: ${result.providers} nhà cung cấp, ${result.models} model, ` +
        `${result.keys} key, ${result.mappings} mapping`
    );
    toast('Đã nhập');
  } catch (error) {
    log('lỗi nhập tệp: ' + (error?.message ?? error));
    toast('Nhập thất bại');
  } finally {
    await refresh();
  }
}

// -------------------------------------------------------------------- wiring

$('btnAnalyze').addEventListener('click', analyze);
$('btnTestAll').addEventListener('click', testAll);
$('btnRetry').addEventListener('click', () => testFiltered('failed'));
$('btnTestHealthy').addEventListener('click', () => testFiltered(STATUS.HEALTHY));
$('btnTestQuick').addEventListener('click', testQuick);
$('btnSync').addEventListener('click', () => syncModels({ force: true }));
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    applyFilter(chip.dataset.filter);
    openDetail(chip.dataset.filter);
  });
}

$('detailCopyAll').addEventListener('click', copyAllDetail);
$('detailClose').addEventListener('click', () => $('detailDialog').close());

// Manual map + key delete dialogs.
$('keyCancel').addEventListener('click', () => $('keyDialog').close());
$('keyConfirm').addEventListener('click', confirmAddKey);
$('mapCancel').addEventListener('click', () => $('mapDialog').close());
$('mapConfirm').addEventListener('click', confirmManualMap);
$('delCancel').addEventListener('click', () => $('delDialog').close());
$('delConfirm').addEventListener('click', confirmDeleteKey);
$('delRestore').addEventListener('click', confirmRestoreKey);

$('btnCancel').addEventListener('click', () => {
  currentRun?.cancel();
  startupRun?.cancel();
  toast('Đang huỷ…');
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

// Render whatever is already stored, then refresh every provider's model
// list in the background. Kept off the render path so a slow or failing
// provider never delays the first paint.
renderLegend();

// Register the update worker. Pages serves with a 10 minute cache, so without
// this a phone keeps the previous app until the cache expires. Registration
// failure is never fatal: the app simply works with normal caching.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
refresh().then(() => log('sẵn sàng'));

(async () => {
  // Give it a run handle so HUỷ can stop it, but do not setBusy: the tree
  // is already usable and a background refresh must not lock the buttons.
  const run = engine.createRun();
  startupRun = run;
  setCancelVisible(true);
  try {
    if (!(await registry.listProviders()).length) return;
    const summary = await syncAllProviders({
      registry,
      run,
      onProgress: (e) => log(`tải ${e.position}/${e.total} · ${e.provider}`),
    });

    if (summary.cancelled) {
      log('tải nền đãng bị huỷ');
      return;
    }

    log(
      `tải nền xong: ${summary.providers} provider · +${summary.modelsAdded} model` +
        `${summary.failed ? ` · ${summary.failed} lỗi` : ''}` +
        `${summary.skipped ? ` · ${summary.skipped} còn mới, bỏ qua` : ''}`
    );

    // Refresh whenever anything at all landed — including a parked model the
    // resolver attached, which adds zero "new" models. Gating on modelsAdded
    // alone left the tree showing stale state after a successful sync.
    if (summary.providers || summary.resolved) await refresh();
  } catch (error) {
    log('tải nền lỗi: ' + (error?.message ?? error));
  } finally {
    startupRun = null;
    if (!currentRun) setCancelVisible(false);
  }
})();
