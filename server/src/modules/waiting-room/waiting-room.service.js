// Waiting-room rules: who may join, and what to tell people while they wait.
import { AppError } from '../../lib/errors.js';
import { redisNow } from '../reservation/holds.js';
import * as eventsRepository from '../events/events.repository.js';
import { joinQueue, queueStatus } from './waiting-room.js';

async function findEventWithRoom(eventId) {
  const event = await eventsRepository.findEventById(eventId);
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
function describe(status, event, now) {
  const secondsUntilSale = Math.max(0, Math.ceil((new Date(event.saleStartsAt) - now) / 1000));
  return {
    ...status,
    admissionPerSecond: event.admissionPerSecond,
    lobbyOpensAt: lobbyOpensAt(event),
    saleStartsAt: event.saleStartsAt,
    estimatedWaitSeconds:
      status.status === 'waiting' ? secondsUntilSale + Math.ceil(status.position / event.admissionPerSecond) : null,
    serverTime: now,
  };
}

// Joining opens lobbyMinutes BEFORE the sale (the "lobby"); admission starts the moment the sale does.
// Before the lobby opens → 409 LOBBY_NOT_OPEN: nobody can take a place days ahead.
export async function join({ eventId, userId }) {
  const event = await findEventWithRoom(eventId);
  const opensAt = lobbyOpensAt(event);
  const [status, now] = await Promise.all([joinQueue(event.id, userId, { lobbyOpensAtMs: opensAt.getTime() }), redisNow()]);
  if (status.status === 'not_open') {
    throw new AppError(409, 'LOBBY_NOT_OPEN', `The waiting room opens ${event.lobbyMinutes} minutes before the sale`, {
      lobbyOpensAt: opensAt,
    });
  }
  return describe(status, event, now);
}

export async function getStatus({ eventId, userId }) {
  const event = await findEventWithRoom(eventId);
  const [status, now] = await Promise.all([queueStatus(event.id, userId), redisNow()]);
  return describe(status, event, now);
}
