# The whole app as ONE Linux container: the API, which also serves the built website.
# (The worker is the same image with another command.) Build from the REPO ROOT:
#
#   docker build -f server/Dockerfile -t ticketing-api .
#   docker run … ticketing-api                       (API + website: runs migrations, then starts)
#   docker run … ticketing-api node src/worker.js    (the background worker)
#
# Configuration comes from the environment (DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, …): nothing
# secret is baked in. See docs/21-deployment.md.

# ---------- stage 1: build the website (React → static files) ----------
FROM node:24-slim AS website
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --ignore-scripts
COPY client/ client/
RUN npm run build -w client

# ---------- stage 2: the server (only what runs; the build tools stay in stage 1) ----------
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
COPY --from=website /app/client/dist client/dist
ENV CLIENT_DIST=/app/client/dist
WORKDIR /app/server
USER node
EXPOSE 5000
# Bring the database up to date, then start. (Migrations are recorded, so this is a no-op when
# there's nothing new; the worker doesn't migrate.)
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
