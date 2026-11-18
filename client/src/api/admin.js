// Admin endpoints (backend step A6). The server allows these only for role "admin".
import { api } from './client.js'

export const listUsers = ({ limit, offset }) =>
  api(`/admin/users?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`)

export const changeRole = (userId, role) =>
  api(`/admin/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: { role } })
