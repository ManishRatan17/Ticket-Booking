import react from '@vitejs/plugin-react'
import process from 'node:process'
import { defineConfig } from 'vite'

// The Express API (PORT in server/.env). Override with API_URL=http://… npm run dev.
const API_URL = process.env.API_URL ?? 'http://localhost:5000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Forward /api requests to the Express server during development
    proxy: {
      '/api': {
        target: API_URL,
        // When the API isn't running (or is restarting after a file change), answer with a clear
        // JSON error instead of the proxy's bare 500, so the page can say what's wrong.
        configure(proxy) {
          proxy.on('error', (err, req, res) => {
            console.warn(`[proxy] ${req.method} ${req.url} → API not reachable at ${API_URL} (${err.code ?? err.message})`)
            if (!res.writeHead || res.headersSent) return res.destroy?.()
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: { code: 'API_UNREACHABLE', message: `The API server isn't answering at ${API_URL}. Is it running?` },
              }),
            )
          })
        },
      },
    },
  },
})
