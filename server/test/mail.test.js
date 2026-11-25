// Phase 7: real email (Resend) and emails through the job queue. Uses a FAKE Resend. Requires Docker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';

// A fake Resend: records what it gets; answers 500 when told to.
const received = [];
let failNext = false;
const fake = express();
fake.use(express.json());
fake.post('/emails', (req, res) => {
  if (failNext) {
    failNext = false;
    return res.status(500).json({ message: 'temporarily down' });
  }
  received.push({ auth: req.get('authorization'), body: req.body });
  res.json({ id: randomUUID() });
});
const fakeServer = fake.listen(0);
await once(fakeServer, 'listening');

// Before importing the app: a Resend key (→ the real transport, pointed at the fake) and jobs ON
// with a private queue prefix (the general suite has jobs off).
const PREFIX = `test-mail-${randomUUID().slice(0, 8)}`;
Object.assign(process.env, {
  RESEND_API_KEY: 're_test_key',
  RESEND_API_URL: `http://localhost:${fakeServer.address().port}/emails`,
  MAIL_FROM: 'Tickets <tickets@example.com>',
  JOBS_ENABLED: 'true',
  JOBS_PREFIX: PREFIX,
});

const { sendMail, deliverMail } = await import('../src/lib/mailer.js');
const { getQueue, closeQueue } = await import('../src/jobs/queue.js');
const { processors } = await import('../src/jobs/processors.js');
const { closeConnections } = await import('../src/config/connections.js');

after(async () => {
  await getQueue().obliterate({ force: true });
  await closeQueue();
  fakeServer.close();
  await closeConnections();
});

const message = { to: 'ann@example.com', subject: 'Hello', text: 'Your tickets #1, #2' };

test('Resend: the API key as a Bearer token, our sender, the recipient, subject and text', async () => {
  await deliverMail(message);
  assert.deepEqual(received.at(-1), {
    auth: 'Bearer re_test_key',
    body: { from: 'Tickets <tickets@example.com>', to: ['ann@example.com'], subject: 'Hello', text: 'Your tickets #1, #2' },
  });
});

test('Resend down (500) → delivery FAILS (so the job is retried), it doesn\'t pretend it worked', async () => {
  failNext = true;
  await assert.rejects(deliverMail(message), /Resend answered 500/);
});

test('sendMail with jobs on → a "send-email" job (not sent yet); the worker\'s processor sends it', async () => {
  const before = received.length;
  await sendMail({ ...message, subject: 'Queued' });
  assert.equal(received.length, before, 'not sent by the API itself');

  const jobs = await getQueue().getJobs(['waiting', 'delayed', 'prioritized']);
  const job = jobs.find((j) => j.name === 'send-email' && j.data.subject === 'Queued');
  assert.ok(job, 'the job is in the queue');
  assert.equal(job.opts.removeOnComplete, true, 'a delivered email (it may hold a reset link) is not kept');
  assert.equal(job.opts.attempts, 5, 'retried up to 5 times');

  assert.deepEqual(await processors['send-email'](job.data), { sent: true });
  assert.equal(received.at(-1).body.subject, 'Queued');
});
