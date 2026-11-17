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

export const env = {
  port: Number(process.env.PORT) || 5000,
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
};
