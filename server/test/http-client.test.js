// The shared client for outside services: timeouts, safe retries, meaningful errors. A local HTTP
// server plays the outside service (no network, no Docker needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requestJson } from '../src/lib/httpClient.js';

let server, base;
const hits = new Map(); // path → how many requests it got
let flaky = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/ok') return json(200, { trains: [1, 2] });
    if (path === '/missing') return json(404, { error: 'no such train' });
    if (path === '/slow') return setTimeout(() => json(200, {}), 500);
    if (path === '/down') return json(503, {});
    if (path === '/busy') return json(429, {});
    if (path === '/not-json') {
      res.writeHead(200);
      return res.end('<html>maintenance</html>');
    }
    if (path === '/flaky') return ++flaky < 3 ? json(500, {}) : json(200, { ok: true }); // fails twice, then works
    return json(200, {});
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = (path, opts = {}) => requestJson({ service: 'train_provider', url: `${base}${path}`, retryDelayMs: 5, ...opts });

test('2xx and 4xx answers go back to the caller as { status, data }', async () => {
  assert.deepEqual(await call('/ok'), { status: 200, data: { trains: [1, 2] } });
  assert.deepEqual(await call('/missing'), { status: 404, data: { error: 'no such train' } });
  assert.equal(hits.get('/missing'), 1, 'a 404 is an answer, never retried');
});

test('no answer in time → 504 TRAIN_PROVIDER_TIMEOUT (it never hangs), after retrying a GET', async () => {
  const started = Date.now();
  await assert.rejects(call('/slow', { timeoutMs: 100, retries: 1 }), { status: 504, code: 'TRAIN_PROVIDER_TIMEOUT' });
  assert.ok(Date.now() - started < 450, 'gave up at the timeout, didn\'t wait for the slow answer');
  assert.equal(hits.get('/slow'), 2);
});

test('a GET that fails with 5xx is retried and can succeed', async () => {
  assert.deepEqual((await call('/flaky')).data, { ok: true });
  assert.equal(hits.get('/flaky'), 3);
});

test('a POST is NOT retried (it may have booked); 5xx → 502 TRAIN_PROVIDER_ERROR', async () => {
  await assert.rejects(call('/down', { method: 'POST', body: { seat: 'A1' } }), { status: 502, code: 'TRAIN_PROVIDER_ERROR' });
  assert.equal(hits.get('/down'), 1);
});

test('a POST the caller marks idempotent IS retried', async () => {
  await assert.rejects(call('/down', { method: 'POST', idempotent: true, retries: 2 }), { code: 'TRAIN_PROVIDER_ERROR' });
  assert.equal(hits.get('/down'), 1 + 3);
});

test('429 → 503 TRAIN_PROVIDER_BUSY; nothing listening → 502 TRAIN_PROVIDER_UNREACHABLE; HTML → 502', async () => {
  await assert.rejects(call('/busy', { retries: 0 }), { status: 503, code: 'TRAIN_PROVIDER_BUSY' });
  await assert.rejects(requestJson({ service: 'train_provider', url: 'http://127.0.0.1:9/x', retries: 0 }), {
    status: 502,
    code: 'TRAIN_PROVIDER_UNREACHABLE',
  });
  await assert.rejects(call('/not-json'), { status: 502, code: 'TRAIN_PROVIDER_ERROR' });
});
