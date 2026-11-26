// Orders: turning a hold into something you can pay for.
//
//   hold (Redis, 5 min)  ──POST /api/orders──►  order 'pending' (Postgres, same deadline)
//                                                   │ payment webhook (step 2b)
//                                                   ▼
//                                          'paid' + ticket numbers  |  'failed'  |  'expired'
import { pool } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { getHold, releaseHold, redisNow } from '../reservation/holds.js';
import * as eventsRepository from '../events/events.repository.js';
import { eventCancelledError } from '../events/events.service.js';
import * as ordersRepository from './orders.repository.js';

// What the browser sees. (userId, holdId, idempotencyKey stay on the server.)
export function toPublicOrder(order) {
  return {
    id: order.id,
    eventId: order.eventId,
    eventName: order.eventName,
    quantity: order.quantity,
    amountPaise: order.amountPaise,
    status: order.status,
    pool: order.pool, // 'lottery' = won in the lucky draw (My orders can say so)
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    failureReason: order.failureReason,
    ticketNumbers: order.ticketNumbers,
    refund: order.refund, // money given back (payment that bought no tickets, cancelled event)
    createdAt: order.createdAt,
  };
}

// A request with a key we've seen before is a RETRY (double-click, network timeout, page
// reload): answer with the SAME order instead of creating a second one. But the same key with a
// DIFFERENT request means the client is buggy — refuse rather than guess.
function replay(existing, holdId) {
  if (existing.holdId !== holdId) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
  }
  return { order: existing, created: false };
}

// Returns { order, created } — created=false when it's a replay of an earlier request.
export async function createOrder({ userId, holdId, idempotencyKey }) {
  // 1. Seen this key before? (Checked FIRST, so a retry still works after the hold is gone,
  //    e.g. because the order was already paid.)
  const earlier = await ordersRepository.findOrderByIdempotencyKey(pool, userId, idempotencyKey);
  if (earlier) return replay(earlier, holdId);

  // 2. The hold must exist, be yours, and still be running (by REDIS's clock).
  const [hold, now] = await Promise.all([getHold(holdId), redisNow()]);
  if (!hold || hold.userId !== userId) throw new AppError(404, 'HOLD_NOT_FOUND', 'No hold with this id');
  if (hold.expiresAt <= now) throw new AppError(409, 'HOLD_EXPIRED', 'This hold has expired; please hold tickets again');

  // 3. Price is read from the DATABASE, never from the request: the client can't choose it.
  const event = await eventsRepository.findEventById(Number(hold.eventId));
  if (event.cancelledAt) throw eventCancelledError(event); // a hold from just before the cancel
  const amountPaise = event.pricePaise * hold.quantity;

  let orderId;
  try {
    orderId = await ordersRepository.insertOrder(pool, {
      userId,
      eventId: event.id,
      quantity: hold.quantity,
      amountPaise,
      holdId,
      idempotencyKey,
      expiresAt: hold.expiresAt, // the order lives exactly as long as its hold
      pool: hold.pool, // lucky-draw tickets stay lucky-draw tickets (needed to rebuild each pool's stock)
    });
  } catch (err) {
    if (isUniqueViolation(err, 'orders_hold_id_key')) {
      // The SAME key, inserted by a parallel request a moment ago? Then this is a replay, not a
      // conflict. (ON CONFLICT only covers the key's unique index; when 20 requests with one key race,
      // PostgreSQL sometimes reports the clash on the hold's index first. Reproduced: ~15 in 1,200.)
      const sameKey = await ordersRepository.findOrderByIdempotencyKey(pool, userId, idempotencyKey);
      if (sameKey) return replay(sameKey, holdId);
      // A DIFFERENT key for a hold that already has an order (e.g. a second tab).
      const existingId = await ordersRepository.findOrderIdByHold(pool, holdId);
      throw new AppError(409, 'ORDER_EXISTS', 'This hold already has an order', { orderId: existingId });
    }
    throw err;
  }

  if (orderId === null) {
    // Another request with the SAME key inserted a moment before us: return its order.
    return replay(await ordersRepository.findOrderByIdempotencyKey(pool, userId, idempotencyKey), holdId);
  }
  return { order: await ordersRepository.findOrderById(pool, orderId), created: true };
}

// Lazy expiry: an unpaid order past its deadline becomes 'expired' when someone looks at it,
// and its held tickets go back on sale. (The Phase 3 worker will do this for everyone.)
async function expireIfOverdue(orderId) {
  const holdId = await ordersRepository.expireIfOverdue(pool, orderId);
  if (holdId) await releaseHold(holdId); // the system releases it (no user check)
}

export async function getOrder({ orderId, userId }) {
  await expireIfOverdue(orderId);
  const order = await ordersRepository.findOrderForUser(pool, orderId, userId);
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'No order with this id');
  return order;
}

export async function listOrders(userId) {
  return ordersRepository.listOrdersForUser(pool, userId);
}
