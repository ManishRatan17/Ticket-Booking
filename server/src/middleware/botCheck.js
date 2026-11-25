// Bot defence (Phase 5d): "prove you're a person" before the two doors bots love most —
// creating accounts and joining a sale's queue.
//
// How Cloudflare Turnstile works (the same idea as a CAPTCHA, usually without a puzzle):
//
//   1. The page shows Cloudflare's widget (their script, their iframe). It quietly checks the
//      browser — and only sometimes asks for a click.
//   2. Cloudflare gives the PAGE a token: a one-time "this looked like a person", valid 5 minutes.
//   3. The page sends the token with its request (header X-Turnstile-Token).
//   4. THIS file asks Cloudflare, server to server, with our SECRET key: "is this token real,
//      unused, and made for my site?" (siteverify). Only Cloudflare can answer that: the browser
//      could send anything.
//
// Like Google sign-in, the browser only CARRIES something; our server checks it with the issuer.
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export const TOKEN_HEADER = 'x-turnstile-token';
const VERIFY_TIMEOUT_MS = 3000;

// Asks Cloudflare about a token. Returns:
//   'human'        Cloudflare vouches for it
//   'bot'          missing, invalid, expired, already used, or for another site
//   'unavailable'  Cloudflare didn't answer properly (network, timeout, 5xx)
export async function verifyHumanToken(token, ip) {
  if (!token) return 'bot';
  let res;
  try {
    res = await fetch(env.botCheck.verifyUrl, {
      method: 'POST',
      body: new URLSearchParams({ secret: env.botCheck.secretKey, response: token, remoteip: ip ?? '' }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS), // never let a slow Cloudflare hang our requests
    });
  } catch {
    return 'unavailable';
  }
  if (!res.ok) return 'unavailable';
  const result = await res.json().catch(() => null);
  if (!result) return 'unavailable';
  if (result.success === true) return 'human';

  // These codes mean OUR configuration is wrong, not the visitor: say so loudly in the log.
  const codes = result['error-codes'] ?? [];
  if (codes.some((c) => c === 'invalid-input-secret' || c === 'missing-input-secret')) {
    console.error(`[bot-check] Cloudflare rejected our secret key (${codes.join(', ')}): check TURNSTILE_SECRET_KEY`);
  }
  return 'bot';
}

const refuse = () =>
  new AppError(403, 'BOT_CHECK_FAILED', "We couldn't confirm you're a person. Please complete the check and try again.");

// Middleware. Put it AFTER validation: a typo in the form then costs no Cloudflare call, and
// doesn't use up the visitor's single-use token.
export async function requireHuman(req, res, next) {
  if (!env.botCheck.enabled) return next(); // no keys configured (development without keys, the test suite)

  const verdict = await verifyHumanToken(req.get(TOKEN_HEADER), req.ip);
  if (verdict === 'human') return next();
  if (verdict === 'unavailable') {
    // FAIL OPEN, like the rate limits: if Cloudflare is down during a sale, refusing everyone
    // would hand the outage to every real buyer. The other defences (rate limits, purchase cap,
    // one place per account) still stand. Logged, so a long outage gets noticed.
    console.warn(`[bot-check] Cloudflare unavailable, allowing ${req.method} ${req.originalUrl}`);
    return next();
  }
  throw refuse();
}

// HONEYPOT: the register form has a field called "website" that people never see (it's moved
// off-screen) and so never fill in. Simple bots fill in EVERY field. Free, no outside service;
// it only catches simple bots — Turnstile is there for the rest.
// Runs BEFORE validation, because validation drops fields it doesn't know.
export function rejectHoneypot(req, res, next) {
  const trap = req.body?.website;
  if (typeof trap === 'string' && trap.trim() !== '') {
    console.warn(`[bot-check] honeypot field filled on ${req.originalUrl} from ${req.ip}`);
    throw refuse(); // the same answer as a failed check: tells a bot nothing
  }
  next();
}
