// The short in-memory cache for hot data (Phase 6). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShortCache } from '../src/lib/shortCache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('SINGLE-FLIGHT: 1,000 simultaneous misses for one key run the query ONCE', async () => {
  const cache = createShortCache({ ttlMs: 1000 });
  let queries = 0;
  const load = async () => {
    queries += 1;
    await sleep(20); // a slow database
    return { id: 7 };
  };
  const results = await Promise.all(Array.from({ length: 1000 }, () => cache.get('event:7', load)));
  assert.equal(queries, 1);
  assert.ok(results.every((r) => r.id === 7));
});

test('reused for ttlMs, then asked again', async () => {
  const cache = createShortCache({ ttlMs: 50 });
  let queries = 0;
  const load = async () => ++queries;
  assert.equal(await cache.get('k', load), 1);
  assert.equal(await cache.get('k', load), 1, 'within ttl: from memory');
  await sleep(70);
  assert.equal(await cache.get('k', load), 2, 'after ttl: asked again');
});

test('delete(key) forgets at once (a strike or an approval on this server)', async () => {
  const cache = createShortCache({ ttlMs: 10_000 });
  let value = 'before';
  assert.equal(await cache.get('k', async () => value), 'before');
  value = 'after';
  cache.delete('k');
  assert.equal(await cache.get('k', async () => value), 'after');
});

test('a FAILED query is not cached: the next request tries again', async () => {
  const cache = createShortCache({ ttlMs: 10_000 });
  await assert.rejects(cache.get('k', async () => Promise.reject(new Error('db down'))));
  assert.equal(await cache.get('k', async () => 'ok'), 'ok');
});

test('ttlMs 0 = switched off: every call asks', async () => {
  const cache = createShortCache({ ttlMs: 0 });
  let queries = 0;
  await cache.get('k', async () => ++queries);
  await cache.get('k', async () => ++queries);
  assert.equal(queries, 2);
});
