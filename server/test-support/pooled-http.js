// An HTTP client with a CONNECTION POOL, for tests that fire hundreds of requests at once.
//
// Why not fetch()? fetch opens a brand-new TCP connection for every request in flight.
// On Windows, a burst of ~300 new connections to one local port in the same instant gets
// part of them REFUSED (ECONNREFUSED) by the operating system — measured: 68 of 300, whatever
// the server's listen backlog. With a pool, 300 requests share at most `maxSockets`
// keep-alive connections and all get through — which is also how real traffic arrives
// (browsers and load balancers reuse connections).
//
// The requests still RACE: all are in flight together and the server handles up to
// `maxSockets` at the same time, interleaving them at every await. (Phase 1 showed that
// even 2 truly concurrent requests are enough to oversell with unsafe code.)
import http from 'node:http';

export function createPooledClient(baseUrl, { maxSockets = 50 } = {}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets });

  function request(method, path, { headers = {}, body } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          agent,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } : headers,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return { request, close: () => agent.destroy() };
}
