// Requires the Docker containers to be running: `docker compose up -d`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { closeConnections } from '../src/config/connections.js';

let server;
let baseUrl;

before(() => {
  server = createApp().listen(0); // port 0 = let the OS pick any free port
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await closeConnections(); // otherwise open connections keep the test process alive
});

test('GET /api/health reports Postgres and Redis as up', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ok');
  assert.equal(body.services.postgres.status, 'up');
  assert.equal(body.services.redis.status, 'up');
});

test('unknown route returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/nope`);
  assert.equal(res.status, 404);
});
