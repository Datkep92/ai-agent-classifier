import { describe, it, assert, assertEqual } from './harness.js';
import { STATUS, STATUS_META } from '../core/statuses.js';
import { classifyItem } from '../core/classifier.js';

/** Every status a user can actually see, with the explanation we ship. */
const LEGEND = {
  '\u{1F7E2}': 'Khỏe',
  '\u{1F535}': 'Đã quét',
  '\u{1F7E0}': 'Chờ',
  '\u{1F7E3}': 'Hết quota',
  '\u{1F534}': 'Key sai',
  '⚫': 'Hết hạn',
  '\u{1F7E1}': 'Model bị chặn',
  '\u{1F7E4}': 'Lỗi tạm thời',
  '\u{1F6AB}': 'Server lỗi',
  '⚪': 'Lỗi chưa rõ',
  '❓': 'Chưa xác định',
  '⏸️': 'Đã tắt',
};

export function registerLegendCases() {
  describe('LG. Status legend stays in sync with the core', () => {
    it('LG1: every core status has an explanation', () => {
      const missing = Object.values(STATUS).filter((status) => !LEGEND[STATUS_META[status]?.emoji]);
      assertEqual(missing.length, 0, 'no legend entry for: ' + missing.join(', '));
    });

    it('LG2: every legend entry maps to a real status', () => {
      const known = new Set(Object.values(STATUS).map((s) => STATUS_META[s]?.emoji));
      const orphans = Object.keys(LEGEND).filter((emoji) => !known.has(emoji));
      assertEqual(orphans.length, 0, 'legend shows colours the core never produces: ' + orphans.join(' '));
    });

    it('LG3: no two statuses share a colour', () => {
      // 🟵 was used by both DISCOVERED and PROVIDER_DOWN, which made "not yet
      // tested" and "server down" look the same.
      const byEmoji = new Map();
      for (const status of Object.values(STATUS)) {
        const emoji = STATUS_META[status]?.emoji;
        byEmoji.set(emoji, (byEmoji.get(emoji) ?? []).concat(status));
      }

      // ⚪ is the deliberate catch-all for errors we cannot classify further.
      const clashes = [...byEmoji.entries()].filter(
        ([emoji, list]) => list.length > 1 && emoji !== '⚪'
      );

      assertEqual(
        clashes.length,
        0,
        'duplicate colours: ' + clashes.map(([e, l]) => e + '=' + l.join('/')).join(', ')
      );
    });

    it('LG4: key-scoped statuses are exactly the ones that evict a key', () => {
      // The legend must not imply a key can be deleted for something transient.
      const keyScoped = Object.values(STATUS).filter((s) => STATUS_META[s]?.scope === 'key');
      assert(keyScoped.includes(STATUS.AUTH_INVALID), 'invalid auth is the key');
      assert(keyScoped.includes(STATUS.EXPIRED), 'expired is the key');
      assert(!keyScoped.includes(STATUS.RATE_LIMITED), 'a rate limit is not the key');
      assert(!keyScoped.includes(STATUS.MODEL_DENIED), 'a model denial is not the key');
    });

    it('LG5: HEALTHY is reachable and distinct from DISCOVERED', () => {
      assert(STATUS_META[STATUS.HEALTHY].emoji !== STATUS_META[STATUS.DISCOVERED].emoji, 'distinct');
      assertEqual(classifyItem('gpt-4o').type, 'MODEL', 'sanity: classifier still works');
    });
  });
}
