# The API (and the worker: same code, other command) as a Linux container.
# Build from the REPO ROOT (npm workspaces need the root package files):
#
#   docker build -f server/Dockerfile -t ticketing-api .
#   docker run … ticketing-api                       (the API)
#   docker run … ticketing-api node src/worker.js    (the worker)
#
# Used by the Phase 6 load test (so the API runs on Linux like a real server, next to PostgreSQL,
# Redis and k6), and the starting point for deployment in Phase 7. Configuration comes from the
# environment (DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, …): nothing secret is baked in.
FROM node:24-slim

WORKDIR /app
# Dependencies first (their own layer: rebuilt only when the package files change).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# --omit=dev: no test or build tools. --ignore-scripts: install scripts don't run (as in development,
# where package.json's allowScripts denies them); argon2 loads its prebuilt Linux binary at runtime.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server/ server/
WORKDIR /app/server
USER node
EXPOSE 5000
CMD ["node", "src/index.js"]
