// Blocks ticket BOOKING (hold, join a queue, order, pay) for a suspended or banned account.
// Put it right after `authenticate` and BEFORE the per-user rate limits: a restricted account is
// turned away here, so it can't keep collecting signals.
//
// The person can still log in, read, release tickets and use the support inbox (to appeal):
// a restriction pauses booking, it doesn't lock anyone out of their own account.
//
// Checked in PostgreSQL (one indexed query): always right, and a suspension simply ends when
// its date passes.
import { AppError } from '../lib/errors.js';
import { restrictionFor } from '../modules/moderation/moderation.service.js';

export async function requireNotRestricted(req, res, next) {
  const r = await restrictionFor(req.user.id);
  if (!r) return next();
  throw new AppError(
    403,
    'ACCOUNT_RESTRICTED',
    r.kind === 'banned'
      ? 'This account is banned from booking tickets because of automated (bot-like) activity.'
      : `Ticket booking is paused on this account until ${new Date(r.until).toUTCString()} because of automated (bot-like) activity.`,
    { kind: r.kind, until: r.until, reason: r.reason },
  );
}
