// One function per auth endpoint. Pages call these, never fetch() directly.
import { api } from './client.js'

// botToken: from the "are you a person?" widget. website: the honeypot field (empty for people).
export const register = (email, password, { botToken, website } = {}) =>
  api('/auth/register', {
    method: 'POST',
    body: website ? { email, password, website } : { email, password },
    headers: botToken ? { 'X-Turnstile-Token': botToken } : {},
  })

export const login = (email, password) =>
  api('/auth/login', { method: 'POST', body: { email, password } })

export const logout = () => api('/auth/logout', { method: 'POST', retryOnExpiry: false })

export const logoutAll = () => api('/auth/logout-all', { method: 'POST' })

export const me = () => api('/auth/me')

export const listSessions = () => api('/auth/sessions')

export const revokeSession = (id) => api(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const forgotPassword = (email) => api('/auth/forgot-password', { method: 'POST', body: { email } })

export const resetPassword = (token, password) =>
  api('/auth/reset-password', { method: 'POST', body: { token, password } })

// Google sign-in is a full-page navigation, not fetch(): the browser must go to Google.
export const GOOGLE_SIGN_IN_URL = '/api/auth/google'
