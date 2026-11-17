// Tests for the shared building blocks: error format, validation, security headers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import { validate } from '../src/middleware/validate.js';
import { notFound, errorHandler } from '../src/middleware/errorHandler.js';
import { closeConnections } from '../src/config/connections.js';

// A tiny app with test-only routes, wired with the REAL middleware.
function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  const schema = z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    age: z.number().int().min(0),
  });
  app.post('/echo', validate({ body: schema }), (req, res) => res.json(req.validated.body));

  app.get('/conflict', () => {
    throw new AppError(409, 'SOMETHING_TAKEN', 'That is taken');
  });
  app.get('/bug', async () => {
    // Express 5 catches errors from async handlers automatically.
    throw new Error('secret database password is hunter2');
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

let testServer, testUrl, realServer, realUrl;

before(() => {
  testServer = createTestApp().listen(0);
  testUrl = `http://localhost:${testServer.address().port}`;
  realServer = createApp().listen(0);
  realUrl = `http://localhost:${realServer.address().port}`;
});

after(async () => {
  testServer.close();
  realServer.close();
  await closeConnections();
});

function postJson(path, body) {
  return fetch(`${testUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('valid body: passes, normalised, unknown fields removed', async () => {
  const res = await postJson('/echo', { email: '  Ann@Example.COM ', age: 30, isAdmin: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: 'ann@example.com', age: 30 });
});

test('invalid body: 400 with a list of every problem', async () => {
  const res = await postJson('/echo', { email: 'not-an-email', age: -1 });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  const fields = body.error.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['body.age', 'body.email']);
});

test('broken JSON: 400 INVALID_JSON', async () => {
  const res = await postJson('/echo', '{"email": ');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');
});

test('body over 10 KB: 413 PAYLOAD_TOO_LARGE', async () => {
  const res = await postJson('/echo', { email: 'a@b.co', age: 1, padding: 'x'.repeat(20_000) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('AppError: its status and code reach the client', async () => {
  const res = await fetch(`${testUrl}/conflict`);
  assert.equal(res.status, 409);
  assert.deepEqual((await res.json()).error, { code: 'SOMETHING_TAKEN', message: 'That is taken' });
});

test('unexpected error: generic 500, internal message NOT leaked', async () => {
  const originalConsoleError = console.error;
  console.error = () => {}; // keep the test output clean; the handler logs on purpose
  try {
    const res = await fetch(`${testUrl}/bug`);
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(text).error.code, 'INTERNAL_ERROR');
    assert.ok(!text.includes('hunter2'), 'internal error message leaked to the client');
  } finally {
    console.error = originalConsoleError;
  }
});

test('real app: unknown route returns 404 in the standard format', async () => {
  const res = await fetch(`${realUrl}/api/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('real app: helmet security headers are set, X-Powered-By is hidden', async () => {
  const res = await fetch(`${realUrl}/api/nope`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('x-powered-by'), null);
});
