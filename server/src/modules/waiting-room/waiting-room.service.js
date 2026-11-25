// Waiting-room rules: who may join, and what to tell people while they wait.
import { AppError } from '../../lib/errors.js';
import { redisNow } from '../reservation/holds.js';
import { joinQueue, queueStatus } from './waiting-room.js';
import { estimateChance } from './chance.js';
import { ensureStock, findEventCached } from '../events/events.service.js';
import { lotteryInfo } from '../lottery/lottery.service.js';

async function findEventWithRoom(eventId) {
  const event = await findEventCached(eventId); // checked every second by every live stream
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
  if (!event.admissionPerSecond) {
    throw new AppError(409, 'NO_WAITING_ROOM', 'This event has no waiting room; you can hold tickets directly');
  }
  return event;
}

// The waiting room ("lobby") opens lobbyMinutes before the sale.
const lobbyOpensAt = (event) => new Date(new Date(event.saleStartsAt).getTime() - event.lobbyMinutes * 60_000);

// Adds what the page needs: the server's time (for countdowns) and a rough wait estimate.
// Estimate = (seconds until the sale opens, if it hasn't) + position ÷ people let in per second.
// In the lobby there's no position yet, so no estimate either (the page says "drawn at 11:00").
// ticketsLeft = the live stock (Redis): it feeds the "what are my chances?" estimate (chance.js).
// lottery = the lucky draw as this person sees it (lottery.service.js), or null.
function describe(status, event, now, ticketsLeft, lottery = null) {
  const secondsUntilSale = Math.max(0, Math.ceil((new Date(event.saleStartsAt) - now) / 1000));
  return {
    ...status,
    ...estimateChance({ ...status, ticketsLeft, soldOutForGood: event.ticketsSold >= event.totalTickets }),
    admissionPerSecond: event.admissionPerSecond,
    lobbyOpensAt: lobbyOpensAt(event),
    saleStartsAt: event.saleStartsAt,
    estimatedWaitSeconds:
      status.status === 'waiting' ? secondsUntilSale + Math.ceil(status.position / event.admissionPerSecond) : null,
    lottery,
    serverTime: now,
  };
}

// Joining opens lobbyMinutes BEFORE the sale (the "lobby"); admission starts the moment the sale does.
// Everyone in the lobby gets a random place (the fair draw); later arrivals queue behind them.
// Before the lobby opens → 409 LOBBY_NOT_OPEN: nobody can take a place days ahead.
export async function join({ eventId, userId }) {
  const event = await findEventWithRoom(eventId);
  const opensAt = lobbyOpensAt(event);
  const [status, now, ticketsLeft] = await Promise.all([
    joinQueue(event.id, userId, {
      lobbyOpensAtMs: opensAt.getTime(),
      saleStartsAtMs: new Date(event.saleStartsAt).getTime(),
      hasLuckyDraw: event.lotteryTickets > 0,
    }),
    redisNow(),
    ensureStock(event),
  ]);
  if (status.status === 'not_open') {
    throw new AppError(409, 'LOBBY_NOT_OPEN', `The waiting room opens ${event.lobbyMinutes} minutes before the sale`, {
      lobbyOpensAt: opensAt,
    });
  }
  return describe(status, event, now, ticketsLeft, await lotteryInfo(event, userId));
}

export async function getStatus({ eventId, userId }) {
  const event = await findEventWithRoom(eventId);
  const [now, ticketsLeft, lottery] = await Promise.all([redisNow(), ensureStock(event), lotteryInfo(event, userId)]);
  const status = await queueStatus(event.id, userId, { inLobby: now < new Date(event.saleStartsAt) });
  return describe(status, event, now, ticketsLeft, lottery);
}
