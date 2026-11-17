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

export const env = {
  port: Number(process.env.PORT) || 5000,
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  jwt: {
    accessSecret: requiredSecret('JWT_ACCESS_SECRET'),
    accessTtlSeconds: 15 * 60, // access tokens live 15 minutes
    issuer: 'flash-sale-api', // who created the token
    audience: 'flash-sale-web', // who the token is meant for
  },
};
