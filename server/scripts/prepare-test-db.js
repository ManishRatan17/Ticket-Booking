// Runs automatically before `npm test` (the "pretest" script): makes sure the TEST database exists
// and is migrated. Tests never touch the development database (DATABASE_URL in .env.test points at
// ticketing_test, and REDIS_URL at Redis database 1).
//
// Why a separate database: in development, tests shared your data. A real admin made the "last
// admin" tests skip; 10,000 load-test users pushed a test's admin off a page; interrupted runs left
// test users behind. Now tests have their own world, and development data is never touched.
import pg from 'pg';
import { env } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';
import { closeConnections } from '../src/config/connections.js';

const target = new URL(env.databaseUrl);
const dbName = target.pathname.slice(1);
if (!/test/.test(dbName)) {
  // A safety net: this script must never be pointed at a real database.
  console.error(`Refusing to prepare "${dbName}": the test database's name must contain "test" (see server/.env.test)`);
  process.exit(1);
}

// CREATE DATABASE can't run inside the database it creates: connect to the built-in "postgres" one.
const admin = new URL(env.databaseUrl);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (rowCount === 0) {
  await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  console.log(`created the test database "${dbName}"`);
}
await client.end();

await runMigrations({ log: () => {} });
await closeConnections();
console.log(`test database "${dbName}" ready`);
