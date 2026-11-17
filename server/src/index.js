import { env } from './config/env.js';
import { createApp } from './app.js';
import { closeConnections } from './config/connections.js';

const server = createApp().listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});

// Graceful shutdown: on Ctrl+C (SIGINT) or a platform stop signal (SIGTERM),
// stop accepting new requests, let in-flight ones finish, then close DB/Redis connections.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await closeConnections();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
