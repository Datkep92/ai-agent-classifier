/** Minimal zero-dependency test harness (§33). */

const suites = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  if (!current) throw new Error('it() outside describe()');
  current.tests.push({ name, fn });
}

export function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message || 'values differ'}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message || 'values differ'}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const suite of suites) {
    console.log(`\n${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.fn();
        passed += 1;
        console.log(`  PASS  ${test.name}`);
      } catch (error) {
        failed += 1;
        failures.push({ suite: suite.name, test: test.name, error });
        console.log(`  FAIL  ${test.name}`);
        console.log(`        ${String(error.message).split('\n').join('\n        ')}`);
      }
    }
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`TOTAL: ${passed + failed}   PASSED: ${passed}   FAILED: ${failed}`);
  console.log('='.repeat(52));

  if (failures.length) {
    console.log('\nFailure detail:');
    for (const f of failures) {
      console.log(`- ${f.suite} > ${f.test}`);
      console.log(`  ${f.error.stack?.split('\n').slice(0, 3).join('\n  ')}`);
    }
  }

  return failed === 0;
}
