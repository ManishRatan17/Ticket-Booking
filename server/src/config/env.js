import { randomBytes } from 'node:crypto';

// Reads settings from environment variables (loaded from server/.env) in ONE place,
// so the rest of the code never touches process.env directly.

function required(name) {
  const value = process.env[name];
  if (!value) {
    // Fail fast: better to crash at startup with a clear message
    // than to fail later with a confusing "connection refused".
    throw new Error(`Missing required environment variable: ${name} (see server/.env.example)`);
  }
  return value;
}

// A signing secret must be long and random, or attackers can brute-force it and forge tokens.
function requiredSecret(name, minBytes = 32) {
  const value = required(name);
  if (Buffer.byteLength(value, 'utf8') < minBytes) {
    throw new Error(`${name} must be at least ${minBytes} bytes long (see server/.env.example)`);
  }
  return value;
}

const DAY = 24 * 60 * 60; // seconds

// The secret the payment provider signs its webhooks with (HMAC-SHA256).
// Production: REQUIRED (it must match what's configured at the provider).
// Development: the FAKE provider runs inside this same server process, so a random secret
// made at startup works for both sides, and nobody has to add it to .env.
function paymentWebhookSecret() {
  const value = process.env.PAYMENT_WEBHOOK_SECRET;
  if (value) {
    if (Buffer.byteLength(value, 'utf8') < 32) throw new Error('PAYMENT_WEBHOOK_SECRET must be at least 32 bytes long');
    return value;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variable: PAYMENT_WEBHOOK_SECRET');
  }
  return randomBytes(32).toString('hex');
}

// Cloudflare Turnstile, the "are you a person?" check (Phase 5d). Both keys, or neither.
//   neither → the check is OFF (development without keys, the test suite)
//   production → REQUIRED: a missing key must not quietly switch bot protection off.
function botCheckSettings() {
  const siteKey = process.env.TURNSTILE_SITE_KEY || '';
  const secretKey = process.env.TURNSTILE_SECRET_KEY || '';
  if (Boolean(siteKey) !== Boolean(secretKey)) {
    throw new Error('Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither (see server/.env.example)');
  }
  if (!secretKey && process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variables: TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY');
  }
  return {
    enabled: Boolean(secretKey),
    siteKey, // public: the page needs it to show the widget
    secretKey, // private: only for asking Cloudflare
    // Cloudflare's real endpoint; tests point it at a fake Cloudflare.
    verifyUrl: process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  };
}

// Express "trust proxy": which proxies may tell us the client's real IP (X-Forwarded-For).
//   unset/"false" → trust nobody: req.ip is whoever connected to us (safe default)
//   "1"           → trust ONE proxy in front of us (typical on Railway/Render)
//   "loopback"    → trust proxies on this machine (127.0.0.1, ::1)
// Trusting too much is dangerous: anyone can SEND an X-Forwarded-For header, so a fake one
// would let an attacker pick a new "IP" for every request and dodge every rate limit.
function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export const env = {
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT) || 5000,
  cookies: {
    // Secure = browsers send the cookie over HTTPS only. Chrome, Edge and Firefox treat
    // http://localhost as secure, so this works in development. COOKIE_SECURE=false is an
    // escape hatch for local tools that refuse Secure cookies on plain http.
    // It can NEVER be turned off in production.
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE !== 'false',
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  rateLimits: {
    // Turned off only for the general test suite (see server/.env.test). Never in production.
    enabled: process.env.NODE_ENV === 'production' || process.env.RATE_LIMITS_ENABLED !== 'false',
    prefix: process.env.RATE_LIMIT_PREFIX || 'ratelimit', // Redis key prefix (tests use their own)
  },
  databaseUrl: required('DATABASE_URL'),
  // Connections to PostgreSQL per process (Phase 6 load test: 10 was too few for a burst).
  dbPoolMax: Math.max(2, Number(process.env.DB_POOL_MAX ?? 20)),
  // How long hot, rarely-changing data (the event, restrictions, limits) may be reused from memory.
  // 0 = off (the general test suite: some tests change the database directly and expect it at once).
  hotCacheMs: Math.max(0, Number(process.env.HOT_CACHE_MS ?? 1000)),
  redisUrl: required('REDIS_URL'),
  jwt: {
    accessSecret: requiredSecret('JWT_ACCESS_SECRET'),
    accessTtlSeconds: 15 * 60, // access tokens live 15 minutes
    issuer: 'flash-sale-api', // who created the token
    audience: 'flash-sale-web', // who the token is meant for
  },
  session: {
    ttlSeconds: 30 * DAY, // absolute: password needed again after this, however active you are
    refreshTtlSeconds: 7 * DAY, // sliding: each refresh issues a fresh 7-day token
    reuseGraceSeconds: 10, // a token reused this soon is probably a second tab, not an attacker
  },
  holds: {
    // How long held tickets stay reserved (and how long an order has to be paid).
    // 5 minutes; the expiry tests set it to 1–2 seconds.
    seconds: Math.max(1, Number(process.env.HOLD_SECONDS ?? 300)),
  },
  waitingRoom: {
    // How long an admission pass lasts: time to choose tickets after being let in.
    passSeconds: Math.max(1, Number(process.env.ADMISSION_PASS_SECONDS ?? 600)),
    // Redis key prefix. Tests use their own (.env.test), so a development worker admitting
    // people every second never touches the tests' waiting rooms.
    prefix: process.env.WAITING_ROOM_PREFIX || 'wr',
  },
  jobs: {
    // Background jobs (BullMQ). Off only for the general test suite (.env.test): hundreds of
    // test holds would otherwise leave hundreds of delayed jobs in Redis. Never off in production.
    enabled: process.env.NODE_ENV === 'production' || process.env.JOBS_ENABLED !== 'false',
    prefix: process.env.JOBS_PREFIX || 'bull', // Redis key prefix for the queues (tests use their own)
  },
  botCheck: botCheckSettings(),
  moderation: {
    // Bot signals → strikes → suspensions/bans (Phase 5e). Off only for the general test suite
    // (.env.test), whose hundreds of requests from one process would look like a bot. Never off in production.
    enabled: process.env.NODE_ENV === 'production' || process.env.MODERATION_ENABLED !== 'false',
    prefix: process.env.MODERATION_PREFIX || 'bot', // Redis key prefix (tests use their own)
    threshold: 20, // points within the window → a strike
    windowSeconds: 10 * 60,
    // A first strike pauses booking for this many days (15–30 per the plan; default 15).
    suspensionDays: Math.min(30, Math.max(1, Number(process.env.BOT_SUSPENSION_DAYS ?? 15))),
  },
  lottery: {
    // How long one lucky-draw round lasts = how long a winner's lucky pass is valid (10 minutes).
    roundSeconds: Math.max(1, Number(process.env.LOTTERY_ROUND_SECONDS ?? 600)),
  },
  payments: {
    webhookSecret: paymentWebhookSecret(),
    // How long the fake provider waits before calling our webhook (a real one takes seconds).
    fakeDelayMs: Number(process.env.FAKE_PAYMENT_DELAY_MS ?? 800),
  },
  // Email (Phase 7). Without a Resend key, emails are printed in the console (development).
  mail: {
    resendApiKey: process.env.RESEND_API_KEY || null,
    // Resend's shared test sender works without your own domain, but only delivers to YOUR address.
    from: process.env.MAIL_FROM || 'Flash-Sale Tickets <onboarding@resend.dev>',
    resendUrl: process.env.RESEND_API_URL || 'https://api.resend.com/emails', // tests point it at a fake
  },
  // The built React app (client/dist). When set, the API also serves the website: ONE service, one
  // address, so the login cookies and CSRF checks work as in development. The Docker image sets it.
  clientDist: process.env.CLIENT_DIST || null,
  // Where the browser is sent after Google sign-in (the React app).
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  // "Continue with Google". OPTIONAL: without a client id/secret the Google routes answer 503.
  // The URL settings default to Google's real endpoints; tests point them at a fake provider.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5173/api/auth/google/callback',
    authUrl: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    jwksUrl: process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
    // Google's documentation says ID tokens use either of these two issuer values.
    issuers: process.env.GOOGLE_ISSUER
      ? [process.env.GOOGLE_ISSUER]
      : ['https://accounts.google.com', 'accounts.google.com'],
  },
};
