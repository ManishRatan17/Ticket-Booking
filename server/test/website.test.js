// Phase 7: in production the API also serves the built website (CLIENT_DIST). Requires Docker
// (the app connects to PostgreSQL and Redis at startup).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A tiny "built website" in a temp folder, set BEFORE the app is imported (env.js reads it once).
const dist = mkdtempSync(path.join(tmpdir(), 'website-'));
writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
mkdirSync(path.join(dist, 'assets'));
writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
process.env.CLIENT_DIST = dist;

const { createApp } = await import('../src/app.js');
const { closeConnections } = await import('../src/config/connections.js');
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;

after(async () => {
  server.close();
  await closeConnections();
  rmSync(dist, { recursive: true, force: true });
});

test('the website: / and any React page (e.g. /events/12) get index.html', async () => {
  for (const page of ['/', '/events/12', '/admin/events/3', '/reset-password']) {
    const res = await fetch(`${base}${page}`);
    assert.equal(res.status, 200, page);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /id="root"/);
  }
});

test('/api stays the API: real answers as JSON, unknown /api paths → 404 JSON (never the website)', async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).status, 'ok');
  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');
});

test('built files are cached for a year (their names change when their content does)', async () => {
  const res = await fetch(`${base}/assets/index-abc123.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=31536000.*immutable/);
});

test('the security policy allows Cloudflare\'s "are you a person?" widget, and nothing else from outside', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /default-src 'self'/);
});
