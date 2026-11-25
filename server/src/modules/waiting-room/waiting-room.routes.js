// Waiting room. Mounted at /api in app.js. You must be signed in: the queue holds USERS,
// one place each, so opening ten tabs or reloading never gets you a second (or a better) place.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { eventIdParamsSchema } from '../events/events.schemas.js';
import * as waitingRoom from './waiting-room.service.js';
import { queueJoinPerIp, queueJoinPerUser, queueStatusPerUser, queueStreamPerUser } from '../../lib/ticketRateLimits.js';

const router = Router();

router.post('/events/:id/queue', queueJoinPerIp, authenticate, queueJoinPerUser, validate({ params: eventIdParamsSchema }), async (req, res) => {
  res.json(await waitingRoom.join({ eventId: req.validated.params.id, userId: req.user.id }));
});

router.get('/events/:id/queue', authenticate, queueStatusPerUser, validate({ params: eventIdParamsSchema }), async (req, res) => {
  res.json(await waitingRoom.getStatus({ eventId: req.validated.params.id, userId: req.user.id }));
});

// ---------------------------------------------------------------------------
// Live updates: Server-Sent Events (SSE)
// ---------------------------------------------------------------------------
// One HTTP response that stays OPEN; we write a message into it whenever the position changes:
//
//   event: status
//   data: {"status":"waiting","position":12,…}
//   (blank line = end of one message)
//
// Why SSE and not WebSockets: updates only flow server → browser, SSE is plain HTTP (cookies,
// proxies and our auth just work), and browsers reconnect automatically.
// Each open stream reads Redis once a second (ZRANK is cheap). With several API servers,
// Redis pub/sub could push changes instead — a Phase 8 idea.
const STREAM_CHECK_MS = 1000;
const STREAM_HEARTBEAT_MS = 15_000; // a comment line now and then stops proxies closing an idle stream
const STREAM_MAX_MS = 10 * 60_000; // after 10 min the browser simply reconnects (and is re-authenticated)

router.get('/events/:id/queue/stream', authenticate, queueStreamPerUser, validate({ params: eventIdParamsSchema }), async (req, res) => {
  const args = { eventId: req.validated.params.id, userId: req.user.id };
  const first = await waitingRoom.getStatus(args); // 404 / 409 still answered as normal JSON errors

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform', // never cache or compress a live stream
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx-style proxies not to hold messages back
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n'); // if the connection drops, the browser reconnects after 2 s

  let lastKey = null;
  let closed = false;
  const send = (status) => {
    // Only send when something visible changed (not just the clock).
    const key = `${status.status}|${status.position}|${status.total}`;
    if (key === lastKey) return;
    lastKey = key;
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    if (status.status === 'admitted') finish(); // nothing more to wait for
  };

  const timer = setInterval(async () => {
    try {
      send(await waitingRoom.getStatus(args));
    } catch {
      finish(); // e.g. the event was deleted: end the stream; the browser will ask again
    }
  }, STREAM_CHECK_MS);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), STREAM_HEARTBEAT_MS);
  const limit = setTimeout(() => finish(), STREAM_MAX_MS);

  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    clearTimeout(limit);
    res.end();
  }
  req.on('close', finish); // the browser left (tab closed, navigated away): stop working for it

  send(first);
});

export default router;
