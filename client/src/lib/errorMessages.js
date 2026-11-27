// Turns server error CODES into text for people. The server's `message` is the fallback;
// codes listed here get wording that fits the screen they appear on.
import { ApiError } from '../api/client.js'

const MESSAGES = {
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  EMAIL_TAKEN: 'An account with this email already exists. Try logging in instead.',
  RESET_TOKEN_INVALID: 'This reset link is invalid, already used or expired. Request a new one below.',
  SESSION_REVOKED: 'You were signed out. Please log in again.',
  SESSION_EXPIRED: 'Your session expired. Please log in again.',
  REFRESH_TOKEN_REUSED: 'For your security you were signed out. Please log in again.',
  CSRF_REJECTED: 'This request was blocked for security reasons. Reload the page and try again.',
  AUTH_UNAVAILABLE: 'Sign-in is temporarily unavailable. Please try again in a moment.',
  // Events and holds
  EVENT_NOT_FOUND: 'This event does not exist.',
  HOLD_NOT_FOUND: 'That hold no longer exists (it may have expired).',
  SALE_NOT_STARTED: 'Tickets for this event are not on sale yet.',
  HOLD_EXISTS: 'You already have tickets on hold for this event.',
  // PURCHASE_LIMIT keeps the server's message: it says the limit and how many you have.
  // SOLD_OUT keeps the server's message: it says how many are left.
  // Orders and payment
  HOLD_EXPIRED: 'Your hold expired. Please hold tickets again.',
  ORDER_NOT_FOUND: 'This order does not exist.',
  ORDER_EXISTS: 'You already started checkout for these tickets.',
  NOT_ADMITTED: "It isn't your turn yet. Join the queue first; you can hold tickets once you're let in.",
  NO_WAITING_ROOM: 'This event has no waiting room.',
  // LUCKY_DRAW_LIMIT keeps the server's message: it says how many a winner may buy.
  LOBBY_NOT_OPEN: 'The waiting room is not open yet. It opens a few minutes before the sale.',
  BOT_CHECK_FAILED: "We couldn't confirm you're a person. Please complete the check and try again.",
  ORDER_NOT_PENDING: 'This order is no longer waiting for payment.',
  // Support inbox
  REQUEST_NOT_FOUND: 'That request does not exist.',
  REQUEST_CLOSED: 'This request has been answered and closed. Start a new one if you need more help.',
  REQUEST_NOT_OPEN: 'This request was already decided (maybe by another admin). Reload to see it.',
  NOT_APPROVABLE: "Questions can't be approved. Close this one instead.",
  // Bot strikes (ACCOUNT_RESTRICTED keeps the server's message: it has the date)
  NOT_RESTRICTED: 'Your account is not restricted, so there is nothing to appeal.',
  ALREADY_RESTRICTED: 'This account is already restricted.',
  CANNOT_RESTRICT_SELF: 'You cannot restrict your own account.',
  NOT_IN_FORCE: 'This restriction is no longer in force.',
  RESTRICTION_NOT_FOUND: 'That restriction no longer exists.',
  // Payments
  PAYMENT_SIGNATURE_INVALID: 'The payment could not be verified. If money was taken, it will be confirmed or refunded automatically.',
  PAYMENTS_UNAVAILABLE: 'The payment provider is not answering. Please try again in a moment.',
  REFUND_NOT_FOUND: 'That refund no longer exists.',
  ALREADY_REFUNDED: 'This refund is already done.',
  // Admins run the sale
  ADMINS_CANNOT_BUY: "Admin accounts can't buy tickets. Use a normal account to buy.",
  ADMINS_USE_INBOX: 'Admins answer requests in the Support inbox.',
  SALE_STARTED: 'The sale has started: only the name can be changed now.',
  LOTTERY_NEEDS_ROOM: 'This event has a lucky draw, which needs its waiting room.',
  EVENT_CANCELLED: 'This event has been cancelled. Anyone who paid gets their money back automatically.',
  ALREADY_CANCELLED: 'This event is already cancelled.',
  // Development: the website can't reach the API (stopped, or restarting after a file change)
  API_UNREACHABLE: 'The server is not answering right now (it may be restarting). Please try again in a few seconds.',
  // Admin
  FORBIDDEN: 'You do not have permission to do this.',
  LAST_ADMIN: 'This is the only admin left. Make someone else an admin first.',
  USER_NOT_FOUND: 'That user no longer exists.',
  JOB_NOT_FOUND: 'That job no longer exists.',
  JOB_NOT_FAILED: 'Only failed jobs can be retried.',
  // Reasons the server's Google callback can send back in ?reason=
  OAUTH_TX_INVALID: 'Google sign-in expired or was already used. Please try again.',
  OAUTH_STATE_MISMATCH: 'Google sign-in could not be verified. Please try again.',
  GOOGLE_NOT_CONFIGURED: 'Google sign-in is not set up on this server yet.',
  GOOGLE_EMAIL_UNVERIFIED: 'Your Google account email is not verified, so it cannot be used here.',
  GOOGLE_ACCOUNT_CONFLICT: 'This email is already linked to a different Google account.',
  GOOGLE_UNAVAILABLE: 'Could not reach Google. Please try again.',
}

// Any error → one sentence for the user.
export function errorMessage(err) {
  if (typeof err === 'string') return MESSAGES[err] ?? 'Something went wrong. Please try again.'
  if (!(err instanceof ApiError)) return 'Could not reach the server. Check your connection and try again.'
  return MESSAGES[err.code] ?? err.message
}

// The server's per-field validation errors → { email: '…', password: '…' } for the form.
// ("body.password" → "password")
export function fieldErrors(err) {
  const result = {}
  if (!(err instanceof ApiError) || !Array.isArray(err.details)) return result
  for (const { field, message } of err.details) {
    const name = field?.split('.').pop()
    if (name && !result[name]) result[name] = message
  }
  return result
}
