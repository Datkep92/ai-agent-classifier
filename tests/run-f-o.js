import { run } from './harness.js';
import { createMockFetch } from './mock-fetch.js';
import { registerCasesFtoO } from './cases-f-to-o.js';
import { OK_CHAT } from './cases-a-to-e.js';

const mock = createMockFetch({ '/chat/completions': OK_CHAT });
globalThis.fetch = mock;
registerCasesFtoO(mock);
const ok = await run();
process.exit(ok ? 0 : 1);
