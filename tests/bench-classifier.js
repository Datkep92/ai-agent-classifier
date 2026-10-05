/**
 * Classifier benchmark.
 *
 * Run before and after any classifier change:
 *   node --no-experimental-fetch tests/bench-classifier.js
 *
 * Reports accuracy per type and lists every misclassified sample, so a
 * change that helps one type while silently breaking another is obvious.
 */
import { classifyItem } from '../core/classifier.js';
import { CORPUS, corpusStats } from './corpus.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const expected = corpusStats();
const results = [];

for (const item of CORPUS) {
  const got = classifyItem(item.value).type;
  results.push({ ...item, got, pass: got === item.type });
}

const total = results.length;
const passed = results.filter((r) => r.pass).length;

console.log(`\n${BOLD}Classifier benchmark${RESET}`);
console.log(`${DIM}${'='.repeat(52)}${RESET}`);

for (const type of Object.keys(expected)) {
  const subset = results.filter((r) => r.type === type);
  const ok = subset.filter((r) => r.pass).length;
  const colour = ok === subset.length ? GREEN : RED;
  console.log(`${colour}${ok}/${subset.length}${RESET}  ${type}`);
}

console.log(`${DIM}${'='.repeat(52)}${RESET}`);
const overall = passed / total;
const colour = passed === total ? GREEN : RED;
console.log(`${BOLD}${colour}TOTAL ${passed}/${total}  (${(overall * 100).toFixed(1)}%)${RESET}`);

const failures = results.filter((r) => !r.pass);
if (failures.length) {
  console.log(`\n${BOLD}${RED}Sai ${failures.length} mau:${RESET}`);
  for (const f of failures) {
    console.log(`  ${RED}expected ${f.type.padEnd(8)}${RESET} got ${f.got.padEnd(8)} ${DIM}|${RESET} ${f.value}`);
  }
} else {
  console.log(`\n${GREEN}Khong co mau sai.${RESET}`);
}

process.exit(passed === total ? 0 : 1);
