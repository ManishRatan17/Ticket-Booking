// Events and ticket holds: the rules. No HTTP in here.
import { redis } from '../../config/redis.js';
import { AppError } from '../../lib/errors.js';
import { stockKey } from '../reservation/stock.js';
import { createHold, getUserHold, releaseHold, redisNow } from '../reservation/holds.js';
import * as eventsRepository from './events.repository.js';

// ---------------------------------------------------------------------------
// Stock: Postgres is the truth, Redis is the fast working copy
// ---------------------------------------------------------------------------

// Makes sure Redis has this event's stock. If the key is missing (new Redis, restart without
// persistence, flushed…), rebuild it from Postgres:  available = total − sold.
//
// SET … NX = "only if it doesn't exist yet", atomically. If 50 requests notice the missing key
// at the same moment, exactly ONE rebuild wins and the others leave it alone — otherwise a late
// rebuild could overwrite stock that holds had already reduced (tickets created out of nothing).
//
// Known limit: holds that lived in Redis are lost with it, so their tickets come back on sale.
// Acceptable for 5-minute holds; PAID tickets are safe because they're counted in Postgres.
async function ensureStock(event) {
  const key = stockKey(event.id);
  const current = await redis.get(key);
  if (current !== null) return Number(current);

  const sold = await eventsRepository.countSoldTickets(event.id);
  await redis.set(key, event.totalTickets - sold, 'NX');
  return Number(await redis.get(key));
}

async function withAvailability(event, now) {
  return {
    ...event,
    available: await ensureStock(event),
    onSale: new Date(event.saleStartsAt) <= now,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function createEvent({ name, totalTickets, saleStartsAt }) {
  // 1. Postgres first: the event exists for real.
  const event = await eventsRepository.createEvent({ name, totalTickets, saleStartsAt });
  // 2. Then Redis. If this fails, nothing is lost: ensureStock rebuilds it on first use.
  await ensureStock(event).catch((err) => console.warn(`[events] stock for event ${event.id} not loaded yet: ${err.message}`));
  return withAvailability(event, await redisNow());
}

export async function listEvents() {
  const [events, now] = await Promise.all([eventsRepository.listEvents(), redisNow()]);
  return { events: await Promise.all(events.map((e) => withAvailability(e, now))), serverTime: now };
}

async function findEventOr404(eventId) {
  const event = await eventsRepository.findEventById(eventId);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
  return event;
}

export async function getEvent(eventId) {
  const [event, now] = await Promise.all([findEventOr404(eventId), redisNow()]);
  return { event: await withAvailability(event, now), serverTime: now };
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

function toPublicHold(hold) {
  return { id: hold.id, eventId: Number(hold.eventId), quantity: hold.quantity, expiresAt: hold.expiresAt };
}

export async function holdTickets({ eventId, userId, quantity }) {
  const [event, now] = await Promise.all([findEventOr404(eventId), redisNow()]);

  // The SERVER decides when a sale opens. Hiding a button in the browser protects nothing.
  if (new Date(event.saleStartsAt) > now) {
    throw new AppError(409, 'SALE_NOT_STARTED', 'Tickets for this event are not on sale yet', {
      saleStartsAt: event.saleStartsAt,
    });
  }

  await ensureStock(event);
  let result;
  try {
    result = await createHold({ eventId: event.id, userId, quantity });
  } catch (err) {
    // The stock key vanished between ensureStock and the hold (Redis restarted just then):
    // rebuild once more and retry once.
    if (!/No stock set up/.test(err.message)) throw err;
    await ensureStock(event);
    result = await createHold({ eventId: event.id, userId, quantity });
  }

  switch (result.status) {
    case 'held':
      return { hold: toPublicHold(result.hold), serverTime: await redisNow() };
    case 'sold_out':
      throw new AppError(409, 'SOLD_OUT', `Not enough tickets left (${result.available} available)`, {
        available: result.available,
      });
    default: // 'already_holding'
      throw new AppError(409, 'HOLD_EXISTS', 'You already have tickets on hold for this event', {
        holdId: result.holdId,
      });
  }
}

// Your current hold for an event, or null. If it has expired, it's released right here
// (its tickets go back on sale) — "lazy expiry" again, this time when someone LOOKS at it.
export async function getMyHold({ eventId, userId }) {
  await findEventOr404(eventId);
  const hold = await getUserHold(eventId, userId);
  if (hold?.expired) {
    await releaseHold(hold.id);
    return { hold: null, serverTime: await redisNow() };
  }
  return { hold: hold && toPublicHold(hold), serverTime: await redisNow() };
}

// 404 for a hold that isn't yours — not 403: never confirm that someone else's hold exists.
export async function releaseMyHold({ holdId, userId }) {
  const result = await releaseHold(holdId, { userId });
  if (result !== 'released') throw new AppError(404, 'HOLD_NOT_FOUND', 'No hold with this id');
}
