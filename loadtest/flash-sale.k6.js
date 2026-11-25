// Load test, step 2: the crowd (Phase 6). k6 runs in Docker, so nothing to install:
//
//   docker run --rm -v "%cd%/loadtest:/scripts" -e BASE_URL=http://host.docker.internal:5059 ^
//          grafana/k6:0.54.0 run /scripts/flash-sale.k6.js
//
// Reads .data/run.json + .data/users.json (made by setup.mjs). Two scenarios, picked by run.json:
//
//  stampede      10,000 DIFFERENT people press "Hold" within a few seconds, for 300 tickets,
//                with NO waiting room: the worst case for correctness (every request races for stock).
//  waiting-room  10,000 people join the lobby; the sale opens; the admission worker lets 50 per second
//                in; whoever is let in buys 2 (hold → order → pay); everyone keeps checking their status.
//
// Why "arrival rate" and not 10,000 virtual users at once: k6 needs a few MB per virtual user, and
// this laptop has ~4 GB for Docker. An arrival-rate scenario starts N requests per second, each as a
// DIFFERENT person, using as few virtual users as it needs. The server sees the same thing: 10,000
// people's requests arriving within seconds.
import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:5059';
const RATE = Number(__ENV.RATE || 1000); // requests started per second
const run = JSON.parse(open('./.data/run.json'));
const users = new SharedArray('users', () => JSON.parse(open('./.data/users.json')));

// 409 SOLD_OUT / HOLD_EXISTS are normal answers in a sale, not failures. Anything else is.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409));

const held = new Counter('tickets_held');
const soldOut = new Counter('sold_out_answers');
const admittedSeen = new Counter('admitted_people_seen');
const paid = new Counter('payments_started');
const unexpected = new Counter('unexpected_answers');

function headers(user, extra = {}) {
  return {
    Cookie: user.cookie,
    'X-Forwarded-For': user.ip, // each person their own IP (the load-test API trusts this header)
    'Content-Type': 'application/json',
    ...extra,
  };
}

const people = users.length;
const lobbySeconds = Math.ceil(people / RATE);
const startsIn = Math.max(0, Math.ceil((Date.parse(run.saleStartsAt) - Date.now()) / 1000));

export const options = {
  discardResponseBodies: false,
  scenarios:
    run.scenario === 'stampede'
      ? {
          stampede: { executor: 'constant-arrival-rate', exec: 'stampede', rate: RATE, timeUnit: '1s', duration: `${lobbySeconds}s`, preAllocatedVUs: 400, maxVUs: 1500 },
        }
      : {
          join: { executor: 'constant-arrival-rate', exec: 'join', rate: RATE, timeUnit: '1s', duration: `${lobbySeconds}s`, preAllocatedVUs: 300, maxVUs: 1200 },
          // Everyone keeps checking "where am I?" (in the browser: a live stream). Whoever is let in, buys.
          buyers: {
            executor: 'constant-arrival-rate',
            exec: 'checkAndBuy',
            startTime: `${startsIn}s`,
            rate: Number(__ENV.CHECK_RATE || 500),
            timeUnit: '1s',
            duration: __ENV.BUY_DURATION || '60s',
            preAllocatedVUs: 300,
            maxVUs: 1200,
          },
        },
  thresholds: {
    http_req_failed: ['rate==0'], // not ONE unexpected answer (5xx, refused connection, timeout…)
    unexpected_answers: ['count==0'],
  },
};

// ---------- stampede: one "Hold" per person ----------
export function stampede() {
  const user = users[exec.scenario.iterationInTest];
  const res = http.post(`${BASE}/api/events/${run.eventId}/holds`, JSON.stringify({ quantity: 1 }), { headers: headers(user), tags: { step: 'hold' } });
  if (res.status === 201) held.add(1);
  else if (res.status === 409 && res.json('error.code') === 'SOLD_OUT') soldOut.add(1);
  else unexpected.add(1, { status: String(res.status) });
  check(res, { 'held or sold out': (r) => r.status === 201 || r.status === 409 });
}

// ---------- waiting room ----------
export function join() {
  const user = users[exec.scenario.iterationInTest];
  const res = http.post(`${BASE}/api/events/${run.eventId}/queue`, null, { headers: headers(user), tags: { step: 'join' } });
  if (!check(res, { 'joined the lobby': (r) => r.status === 200 && r.json('status') === 'lobby' })) unexpected.add(1, { step: 'join' });
}

export function checkAndBuy() {
  const user = users[exec.scenario.iterationInTest % people]; // sweep over everyone, again and again
  const status = http.get(`${BASE}/api/events/${run.eventId}/queue`, { headers: headers(user), tags: { step: 'status' } });
  if (status.status !== 200) return unexpected.add(1, { step: 'status' });
  if (status.json('chance') === 'sold_out') return soldOut.add(1);
  if (status.json('status') !== 'admitted') return;

  admittedSeen.add(1);
  const holdRes = http.post(`${BASE}/api/events/${run.eventId}/holds`, JSON.stringify({ quantity: 2 }), { headers: headers(user), tags: { step: 'hold' } });
  if (holdRes.status !== 201) return holdRes.status === 409 ? null : unexpected.add(1, { step: 'hold' });
  held.add(2);

  const orderRes = http.post(`${BASE}/api/orders`, JSON.stringify({ holdId: holdRes.json('hold.id') }), {
    headers: headers(user, { 'Idempotency-Key': `${run.run}-${user.id}` }),
    tags: { step: 'order' },
  });
  if (orderRes.status !== 201 && orderRes.status !== 200) return unexpected.add(1, { step: 'order' });

  // The fake provider calls our webhook back ~1 s later; the Host header makes it call the API itself.
  const payRes = http.post(`${BASE}/api/payments/fake/${orderRes.json('order.id')}`, JSON.stringify({ outcome: 'success' }), {
    headers: headers(user, { Host: 'localhost:5059' }),
    tags: { step: 'pay' },
  });
  if (payRes.status === 202) paid.add(1);
  else unexpected.add(1, { step: 'pay' });
}

export function handleSummary(data) {
  const m = (name, field) => data.metrics[name]?.values?.[field];
  const summary = {
    scenario: run.scenario,
    people,
    tickets: run.tickets,
    ratePerSecond: RATE,
    requests: m('http_reqs', 'count'),
    requestsPerSecond: Math.round(m('http_reqs', 'rate') ?? 0),
    failedRate: m('http_req_failed', 'rate'),
    latencyMs: {
      median: Math.round(m('http_req_duration', 'med') ?? 0),
      p95: Math.round(m('http_req_duration', 'p(95)') ?? 0),
      max: Math.round(m('http_req_duration', 'max') ?? 0),
    },
    ticketsHeld: m('tickets_held', 'count') ?? 0,
    soldOutAnswers: m('sold_out_answers', 'count') ?? 0,
    admittedPeopleSeen: m('admitted_people_seen', 'count') ?? 0,
    paymentsStarted: m('payments_started', 'count') ?? 0,
    unexpectedAnswers: m('unexpected_answers', 'count') ?? 0,
    droppedIterations: m('dropped_iterations', 'count') ?? 0,
    maxVUs: m('vus_max', 'max'),
  };
  return {
    stdout: `\n${JSON.stringify(summary, null, 2)}\n`,
    [`/scripts/.data/k6-${run.scenario}.json`]: JSON.stringify(summary, null, 2),
  };
}
