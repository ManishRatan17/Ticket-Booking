// A tiny in-memory cache with a short time limit, for data that's read on EVERY click but almost
// never changes (the event, "is this account restricted?", "what's this person's limit?").
//
// Found by the Phase 6 load test: 1,000 "Hold" clicks a second each asked PostgreSQL the same
// questions, 10 connections couldn't keep up, requests waited > 2 s and failed. With this cache:
//   • the answer is reused for ttlMs (default 1 s): at most one query per key per second
//   • SINGLE-FLIGHT: 1,000 requests missing the same key at the same moment share ONE query
//     (the promise is cached, not just the result)
//   • a failed query is not cached (the next request tries again)
// The price: another server may see a change up to ttlMs late. On THIS server, writes call
// delete(key) so their own change shows at once. PostgreSQL stays the truth.
export function createShortCache({ ttlMs, maxEntries = 50_000 }) {
  const entries = new Map(); // key → { promise, expires }

  return {
    get(key, load) {
      if (ttlMs <= 0) return load(); // switched off (the general test suite)
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.expires > now) return hit.promise;

      const promise = Promise.resolve().then(load);
      entries.set(key, { promise, expires: now + ttlMs });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value); // oldest first
      return promise;
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
