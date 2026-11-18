// Knows who is signed in, and shares it with every page.
// It never holds a token — only the user object the server returns.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthContext } from './context.js'
import * as authApi from '../api/auth.js'
import { onSessionEnded } from '../api/client.js'

const SIGNED_OUT = { status: 'signed-out', user: null }

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null })

  const signedIn = useCallback((user) => setState({ status: 'signed-in', user }), [])

  // Asks the server who we are. The cookies (if any) answer that; the API client refreshes
  // an expired access cookie by itself, so this one call covers every case.
  const reload = useCallback(async () => {
    try {
      const { user } = await authApi.me()
      signedIn(user)
    } catch {
      setState(SIGNED_OUT)
    }
  }, [signedIn])

  // On page load. State is set only in the async callbacks, and `active` stops a component
  // that has already gone away (React StrictMode mounts twice in development) from updating.
  useEffect(() => {
    let active = true
    authApi.me().then(
      ({ user }) => active && setState({ status: 'signed-in', user }),
      () => active && setState(SIGNED_OUT),
    )
    return () => {
      active = false
    }
  }, [])

  // A refresh failed somewhere (logged out elsewhere, session revoked…): show it everywhere.
  useEffect(() => onSessionEnded(() => setState(SIGNED_OUT)), [])

  const login = useCallback(
    async (email, password) => {
      const { user } = await authApi.login(email, password)
      signedIn(user)
      return user
    },
    [signedIn],
  )

  // Register does not sign in by itself (server design), so sign in right after.
  const register = useCallback(
    async (email, password) => {
      await authApi.register(email, password)
      return login(email, password)
    },
    [login],
  )

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      setState(SIGNED_OUT) // even if the request failed, forget the user locally
    }
  }, [])

  const logoutAll = useCallback(async () => {
    await authApi.logoutAll()
    setState(SIGNED_OUT)
  }, [])

  const value = useMemo(
    () => ({ ...state, login, register, logout, logoutAll, reload }),
    [state, login, register, logout, logoutAll, reload],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
