# Flash-Sale Ticketing System

Full-stack starter: **Express** API (Node.js 20.6+) and a **React + Vite** client, managed as npm workspaces.

```
TicketBooking/
├── client/              # React + Vite frontend
│   ├── src/
│   └── vite.config.js   # proxies /api → http://localhost:5000 in dev
├── server/              # Express backend
│   ├── src/
│   │   ├── app.js       # Express app (routes + middleware)
│   │   ├── index.js     # entry point (starts the server)
│   │   ├── routes/
│   │   └── middleware/
│   └── test/            # node:test tests
└── package.json         # root workspace scripts
```

## Getting started

Requires Node.js 20.6+ and Docker Desktop.

```sh
docker compose up -d                 # start PostgreSQL + Redis
npm install
cp server/.env.example server/.env
npm run dev
```

- Client: http://localhost:5173
- API: http://localhost:5000/api/health

## Scripts (run from the root)

| Script          | What it does                                  |
| --------------- | --------------------------------------------- |
| `npm run dev`   | Runs the server (watch mode) and Vite together |
| `npm run build` | Builds the client into `client/dist`          |
| `npm start`     | Starts the API server                         |
| `npm test`      | Runs the server tests                         |
| `npm run lint`  | Lints the client with oxlint                  |

## Adding an API route

1. Create a router in `server/src/routes/`.
2. Mount it in `server/src/app.js`, for example `app.use('/api/todos', todosRouter)`.
3. Call it from React with `fetch('/api/todos')`. In development, Vite forwards the request to Express.
