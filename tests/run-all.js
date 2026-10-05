import { run } from './harness.js';
import { createMockFetch } from './mock-fetch.js';
import { registerCasesAtoE, OK_MODELS, OK_CHAT } from './cases-a-to-e.js';
import { registerCasesFtoO } from './cases-f-to-o.js';
import { registerSecurityCases, bindMock } from './cases-security.js';

const mock = createMockFetch({ '/models': OK_MODELS, '/chat/completions': OK_CHAT });
globalThis.fetch = mock;

registerCasesAtoE(mock);
registerCasesFtoO(mock);
bindMock(mock);
registerSecurityCases();

const ok = await run();
process.exit(ok ? 0 : 1);
