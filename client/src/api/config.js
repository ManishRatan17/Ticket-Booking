// Public settings from the server (GET /api/config). Asked once per page load, then shared.
import { api } from './client.js'

let config = null

export function getPublicConfig() {
  config ??= api('/config').catch((err) => {
    config = null // ask again next time instead of remembering the failure
    throw err
  })
  return config
}
