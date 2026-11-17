// Proves the database itself refuses bad data. Requires `docker compose up -d`.
// Every test runs inside a transaction that is ROLLED BACK, so no test data is left behind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';

before(() => runMigrations({ log: () => {} }));
after(() => closeConnections());

// Runs `fn` inside BEGIN ... ROLLBACK on a single connection.
async function inRolledBackTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Creates a user, an event (10 tickets) and a pending order; returns their ids.
async function seed(client) {
  const user = await client.query(
    `INSERT INTO users (email, password_hash) VALUES ('test@example.com', 'x') RETURNING id`,
  );
  const event = await client.query(
    `INSERT INTO events (name, total_tickets, sale_starts_at) VALUES ('Test', 10, now()) RETURNING id`,
  );
  const order = await client.query(
    `INSERT INTO orders (user_id, event_id, quantity, idempotency_key, expires_at)
     VALUES ($1, $2, 1, 'key-1', now() + interval '5 minutes') RETURNING id`,
    [user.rows[0].id, event.rows[0].id],
  );
  return { userId: user.rows[0].id, eventId: event.rows[0].id, orderId: order.rows[0].id };
}

const UNIQUE_VIOLATION = '23505'; // Postgres error code
const CHECK_VIOLATION = '23514';

test('the same ticket number cannot be sold twice for one event', () =>
  inRolledBackTransaction(async (client) => {
    const { eventId, orderId } = await seed(client);
    const sell = () =>
      client.query(
        'INSERT INTO sold_tickets (event_id, ticket_number, order_id) VALUES ($1, 7, $2)',
        [eventId, orderId],
      );

    await sell(); // first sale of ticket #7 works
    await assert.rejects(sell, { code: UNIQUE_VIOLATION }); // second sale is refused
  }));

test('the same idempotency key cannot create two orders for one user', () =>
  inRolledBackTransaction(async (client) => {
    const { userId, eventId } = await seed(client);
    await assert.rejects(
      client.query(
        `INSERT INTO orders (user_id, event_id, quantity, idempotency_key, expires_at)
         VALUES ($1, $2, 1, 'key-1', now())`,
        [userId, eventId],
      ),
      { code: UNIQUE_VIOLATION },
    );
  }));

test('an order cannot have an unknown status', () =>
  inRolledBackTransaction(async (client) => {
    const { orderId } = await seed(client);
    await assert.rejects(
      client.query(`UPDATE orders SET status = 'teleported' WHERE id = $1`, [orderId]),
      { code: CHECK_VIOLATION },
    );
  }));

test('the same webhook cannot be recorded twice', () =>
  inRolledBackTransaction(async (client) => {
    const record = () =>
      client.query(
        `INSERT INTO processed_webhooks (webhook_id, provider) VALUES ('evt_123', 'fake')`,
      );
    await record();
    await assert.rejects(record, { code: UNIQUE_VIOLATION });
  }));
