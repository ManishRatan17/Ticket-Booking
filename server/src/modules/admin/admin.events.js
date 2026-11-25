// Admin → Manage events: every event with LIVE numbers, and editing an event.
//
// The numbers come from where they live:
//   sold      PostgreSQL (events.tickets_sold: paid tickets, the record)
//   left      Redis (the normal stock, + what the lucky draw still has)
//   held      what's neither sold nor left = in someone's hold right now
//   revenue   PostgreSQL (sum of paid orders)
//   in line   Redis (the waiting room's sorted set), entered in the draw (its set)
import { pool } from '../../config/db.js';
import { redis } from '../../config/redis.js';
import { AppError } from '../../lib/errors.js';
import { ensureStock, forgetEvent, lotteryOpen, lotteryStockLeft } from '../events/events.service.js';
import { redisNow } from '../reservation/holds.js';
import { entrantsKey, queueKey } from '../waiting-room/waiting-room.js';
import * as eventsRepository from '../events/events.repository.js';

async function revenueByEvent(eventIds) {
  const { rows } = await pool.query(
    `SELECT event_id, COALESCE(sum(amount_paise), 0)::bigint AS revenue, count(*)::int AS paid_orders
       FROM orders WHERE status = 'paid' AND event_id = ANY($1::bigint[]) GROUP BY event_id`,
    [eventIds],
  );
  return new Map(rows.map((r) => [Number(r.event_id), { revenuePaise: Number(r.revenue), paidOrders: r.paid_orders }]));
}

async function withLiveNumbers(event, now, money) {
  const [left, lotteryLeft, inLine, entered] = await Promise.all([
    ensureStock(event),
    lotteryStockLeft(event),
    event.admissionPerSecond ? redis.zcard(queueKey(event.id)) : 0,
    event.lotteryTickets > 0 ? redis.scard(entrantsKey(event.id)) : 0,
  ]);
  const sold = event.ticketsSold;
  const available = Math.max(0, left) + lotteryLeft;
  const held = Math.max(0, event.totalTickets - sold - available);
  const started = new Date(event.saleStartsAt) <= now;
  const status =
    sold >= event.totalTickets ? 'sold_out' : !started ? 'upcoming' : available === 0 ? 'all_held' : 'on_sale';
  return {
    ...event,
    status, // upcoming | on_sale | all_held (none left, some only held) | sold_out
    sold,
    held,
    available,
    revenuePaise: money?.revenuePaise ?? 0,
    paidOrders: money?.paidOrders ?? 0,
    inLine,
    luckyDraw: event.lotteryTickets > 0 ? { tickets: event.lotteryTickets, left: lotteryLeft, entered, open: lotteryOpen(event) } : null,
  };
}

export async function listEventsWithNumbers() {
  const [events, now] = await Promise.all([eventsRepository.listEvents(), redisNow()]);
  const money = await revenueByEvent(events.map((e) => e.id));
  return { events: await Promise.all(events.map((e) => withLiveNumbers(e, now, money.get(e.id)))), serverTime: now };
}

export async function getEventWithNumbers(id) {
  const event = await eventsRepository.findEventById(id);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
  const money = await revenueByEvent([event.id]);
  return { event: await withLiveNumbers(event, await redisNow(), money.get(event.id)), serverTime: await redisNow() };
}

// Editing. The NAME can change any time. Price, sale time and waiting-room settings only BEFORE the
// sale opens: changing the price after people paid, or the time after people queued, would be unfair.
// (The number of tickets and the lucky-draw settings are fixed at creation: stock and the draw's
// committed seed are built on them.)
export async function updateEvent(id, changes) {
  const event = await eventsRepository.findEventById(id);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
  const now = await redisNow();
  const saleChanges = ['pricePaise', 'saleStartsAt', 'admissionPerSecond', 'lobbyMinutes'].filter((k) => k in changes);
  if (saleChanges.length > 0 && new Date(event.saleStartsAt) <= now) {
    throw new AppError(409, 'SALE_STARTED', 'The sale has started: only the name can be changed now', { fields: saleChanges });
  }
  if ('admissionPerSecond' in changes && changes.admissionPerSecond === null && event.lotteryTickets > 0) {
    throw new AppError(409, 'LOTTERY_NEEDS_ROOM', 'This event has a lucky draw, which needs its waiting room');
  }
  await eventsRepository.updateEvent(id, changes);
  forgetEvent(id); // this server's 1-second copy (doc 19) forgets the old version at once
  console.log(`[admin] event ${id} changed: ${Object.keys(changes).join(', ')}`);
  return getEventWithNumbers(id);
}
