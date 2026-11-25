// A tiny FAKE Cloudflare Turnstile "siteverify" endpoint for tests (like fake-google.js).
// It answers the way Cloudflare does:
//   200 { success: true }                                       a good, unused token
//   200 { success: false, "error-codes": ["invalid-input-response"] }   unknown token
//   200 { success: false, "error-codes": ["timeout-or-duplicate"] }     a token used before
//   200 { success: false, "error-codes": ["invalid-input-secret"] }     wrong secret key
// and can pretend to be broken (mode 'error' = HTTP 500, 'hangup' = connection dropped).
import express from 'express';
import { once } from 'node:events';

export async function startFakeTurnstile({ secret }) {
  const used = new Set();
  const calls = []; // every request we got: { secret, response, remoteip }
  let mode = 'ok';

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post('/siteverify', (req, res) => {
    calls.push({ ...req.body });
    if (mode === 'error') return res.status(500).json({ error: 'internal' });
    if (mode === 'hangup') return req.socket.destroy();

    const { secret: sent, response } = req.body;
    if (sent !== secret) return res.json({ success: false, 'error-codes': ['invalid-input-secret'] });
    if (!response?.startsWith('human-')) return res.json({ success: false, 'error-codes': ['invalid-input-response'] });
    if (used.has(response)) return res.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    used.add(response); // tokens are single-use, like Cloudflare's
    res.json({ success: true, hostname: 'localhost', 'error-codes': [] });
  });

  const server = app.listen(0);
  await once(server, 'listening');
  let n = 0;
  return {
    url: `http://localhost:${server.address().port}/siteverify`,
    calls,
    newToken: () => `human-${++n}-${Math.random().toString(36).slice(2)}`, // what the widget would give a person
    setMode: (m) => (mode = m),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
