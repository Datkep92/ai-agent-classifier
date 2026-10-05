/**
 * Deterministic mock fetch for tests (§33). No real API calls.
 *
 * Routes map a URL substring to either a response descriptor
 * ({ status, body, headers }) or a handler function.
 *
 * We return a minimal response object rather than the global `Response`
 * so the suite runs identically on Node builds with or without
 * experimental fetch enabled.
 */

function makeHeaders(init = {}) {
  const map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    get: (name) => map.get(String(name).toLowerCase()) ?? null,
    has: (name) => map.has(String(name).toLowerCase()),
    forEach: (fn) => map.forEach((v, k) => fn(v, k)),
  };
}

function makeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders({ 'Content-Type': 'application/json', ...headers }),
    async text() {
      return text;
    },
    async json() {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}

export function createMockFetch(routes = {}, { defaultRoute = null } = {}) {
  const calls = [];

  async function mockFetch(url, options = {}) {
    const href = String(url);
    const method = options.method ?? 'GET';
    calls.push({ url: href, method, options });

    const key = Object.keys(routes).find((pattern) => href.includes(pattern));
    const route = key ? routes[key] : defaultRoute;

    if (!route) {
      return makeResponse({ status: 404, body: { error: { message: 'no mock route' } } });
    }

    const result = typeof route === 'function' ? await route(href, options, calls.length) : route;
    if (result?.__throw) throw new Error(result.message ?? 'network failure');
    if (result?.__abort) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    return makeResponse(result);
  }

  mockFetch.calls = calls;
  mockFetch.routes = routes;
  mockFetch.reset = () => {
    calls.length = 0;
  };
  return mockFetch;
}

export function installMockFetch(mock) {
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = mock;
  };
}

export { makeResponse };
