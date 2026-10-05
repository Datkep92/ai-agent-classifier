import { run } from './harness.js';
import { createMockFetch } from './mock-fetch.js';
import { registerCasesAtoE, OK_MODELS, OK_CHAT } from './cases-a-to-e.js';
import { registerCasesFtoO } from './cases-f-to-o.js';
import { registerSecurityCases, bindMock } from './cases-security.js';
import { registerRecoveryCases } from './cases-recovery.js';
import { registerOpsCases } from './cases-ops.js';
import { registerKeyScanCases } from './cases-key-scan.js';
import { registerMapTestCases } from './cases-map-test.js';

const mock = createMockFetch({ '/models': OK_MODELS, '/chat/completions': OK_CHAT });
globalThis.fetch = mock;

registerCasesAtoE(mock);
registerCasesFtoO(mock);
bindMock(mock);
registerSecurityCases();
registerRecoveryCases(mock);
registerOpsCases(mock);
registerKeyScanCases(mock);
registerMapTestCases(mock);

const ok = await run();
process.exit(ok ? 0 : 1);
