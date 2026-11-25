// The support inbox: people write to the organisers, admins answer and decide.
//
//   person ── POST /support/requests ──► request (open) + first message
//          ◄─ messages back and forth ─►  admin
//   admin  ── decision ──► approved | declined (more tickets) · closed (question)
//                          approved "more tickets" → this person's limit for this event: 4 + extra
import { pool, withTransaction } from '../../config/db.js';
import { AppError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import * as eventsRepository from '../events/events.repository.js';
import * as repo from './support.repository.js';
import { overturnForAppeal, restrictionFor } from '../moderation/moderation.service.js';

const notFound = () => new AppError(404, 'REQUEST_NOT_FOUND', 'No support request with this id');

async function withMessages(request) {
  return { ...request, messages: await repo.listMessages(pool, request.id) };
}

// What the PERSON sees: no admin ids or emails (the answer comes "from the organisers").
function forPerson(request) {
  const { userId: _u, userEmail: _e, ...rest } = request;
  return rest;
}

// ---------- the person ----------

export async function createRequest({ userId, kind, eventId = null, extraTickets = null, message }) {
  if (kind === 'appeal' && !(await restrictionFor(userId))) {
    throw new AppError(409, 'NOT_RESTRICTED', 'Your account is not restricted, so there is nothing to appeal');
  }
  if (eventId !== null && !(await eventsRepository.findEventById(eventId))) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'No event with this id');
  }
  try {
    const id = await withTransaction(async (client) => {
      const requestId = await repo.insertRequest(client, { userId, kind, eventId, extraTickets });
      await repo.insertMessage(client, { requestId, authorId: userId, fromAdmin: false, body: message });
      return requestId;
    });
    return forPerson(await withMessages(await repo.findRequest(pool, id)));
  } catch (err) {
    // One OPEN request per person, kind and event (a unique index): point them to it instead.
    if (isUniqueViolation(err, 'support_one_open_request')) {
      const existing = await repo.findOpenRequestId(pool, { userId, kind, eventId });
      throw new AppError(409, 'REQUEST_EXISTS', 'You already have an open request about this; add to it instead', {
        requestId: existing,
      });
    }
    throw err;
  }
}

export async function listMyRequests(userId) {
  return (await repo.listRequestsForUser(pool, userId)).map(forPerson);
}

export async function getMyRequest(userId, id) {
  const request = await repo.findRequest(pool, id, { userId });
  if (!request) throw notFound();
  return forPerson(await withMessages(request));
}

export async function addMyMessage(userId, id, body) {
  const request = await repo.findRequest(pool, id, { userId });
  if (!request) throw notFound();
  if (request.status !== 'open') throw new AppError(409, 'REQUEST_CLOSED', 'This request has been answered and closed');
  await repo.insertMessage(pool, { requestId: id, authorId: userId, fromAdmin: false, body });
  return getMyRequest(userId, id);
}

// ---------- admins ----------

export const listRequests = ({ status }) => repo.listRequests(pool, { status });

export async function getRequest(id) {
  const request = await repo.findRequest(pool, id);
  if (!request) throw notFound();
  return withMessages(request);
}

export async function addAdminMessage(adminId, id, body) {
  const request = await repo.findRequest(pool, id);
  if (!request) throw notFound();
  await repo.insertMessage(pool, { requestId: id, authorId: adminId, fromAdmin: true, body });
  return getRequest(id);
}

// decision: 'approved' | 'declined' (more tickets) · 'closed' (anything). Optional message to the person.
export async function decide(adminId, id, { decision, message }) {
  const request = await repo.findRequest(pool, id);
  if (!request) throw notFound();
  if (decision === 'approved' && request.kind === 'question') {
    throw new AppError(409, 'NOT_APPROVABLE', 'Questions can\'t be approved; close this one instead');
  }

  await withTransaction(async (client) => {
    const decided = await repo.decide(client, { id, status: decision, adminId });
    if (!decided) throw new AppError(409, 'REQUEST_NOT_OPEN', 'This request was already decided');
    // Approving raises the limit IN THE SAME TRANSACTION: "approved" and "limit raised" happen together.
    // Approving an APPEAL overturns the restriction: booking works again, and it isn't counted
    // as a strike (a mistake isn't the person's fault). Same transaction as the decision.
    if (decision === 'approved' && decided.kind === 'appeal') {
      await overturnForAppeal(client, { userId: decided.user_id, adminId });
    }
    if (decision === 'approved' && decided.kind === 'more_tickets') {
      await repo.grantExtraTickets(client, {
        eventId: decided.event_id,
        userId: decided.user_id,
        extra: decided.extra_tickets,
        requestId: id,
        adminId,
      });
    }
    if (message) await repo.insertMessage(client, { requestId: id, authorId: adminId, fromAdmin: true, body: message });
  });
  console.log(`[support] admin ${adminId} ${decision} request ${id} (${request.kind}, user ${request.userId})`);
  return getRequest(id);
}
