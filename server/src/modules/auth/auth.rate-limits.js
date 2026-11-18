// The rate limits for the auth endpoints, all in one place.
import { rateLimit } from '../../lib/rateLimiter.js';

const MINUTE = 60;
const byIp = (req) => req.ip;

// Login has TWO limits:
//  • per IP: stops one machine trying many different accounts (credential stuffing)
export const loginPerIp = rateLimit({ name: 'login-ip', limit: 30, windowSeconds: 15 * MINUTE, key: byIp });

//  • per IP + email, failed attempts only: stops guessing ONE account's password.
//    Why not per email alone? Then an attacker could lock ANY user out just by failing
//    5 times with their email. With the IP in the key, the attacker only locks themselves.
//    Runs after validation, so the email is already normalised (Ann@X.com = ann@x.com).
export const loginAttempts = rateLimit({
  name: 'login-attempts',
  limit: 5,
  windowSeconds: 15 * MINUTE,
  key: (req) => `${req.ip}|${req.validated.body.email}`,
  resetOnSuccess: true,
});

// Mass account creation (spam, fake accounts to grab tickets).
export const registerPerIp = rateLimit({ name: 'register-ip', limit: 5, windowSeconds: 60 * MINUTE, key: byIp });

// Generous: every open tab refreshes every 15 minutes. This only stops floods.
export const refreshPerIp = rateLimit({ name: 'refresh-ip', limit: 60, windowSeconds: MINUTE, key: byIp });

// Each start creates a Redis entry (oauth-transactions.js): don't let anyone fill Redis.
export const googleStartPerIp = rateLimit({ name: 'google-start-ip', limit: 20, windowSeconds: MINUTE, key: byIp });
