// Admins run the sale; they don't take part in it.
//
//   • booking (hold, join a queue, order, pay): admins → 403 ADMINS_CANNOT_BUY. The people who set
//     the rules shouldn't compete with fans for tickets (and must never be suspected of it). An
//     admin who wants tickets uses a normal account.
//   • the support inbox as a CUSTOMER (asking for help): admins → 403 ADMINS_USE_INBOX. Admins
//     answer requests; they don't send them.
//
// Hiding the buttons in the page is only a convenience: this is what enforces it. Put it right
// after `authenticate` (the role comes from the access token).
import { AppError } from '../lib/errors.js';

export function customersOnly(req, res, next) {
  if (req.user.role === 'admin') {
    throw new AppError(403, 'ADMINS_CANNOT_BUY', "Admin accounts can't buy tickets. Use a normal account to buy.");
  }
  next();
}

export function notForAdmins(req, res, next) {
  if (req.user.role === 'admin') {
    throw new AppError(403, 'ADMINS_USE_INBOX', 'Admins answer requests in the Support inbox; they don\'t send them.');
  }
  next();
}
