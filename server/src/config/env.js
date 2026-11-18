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
