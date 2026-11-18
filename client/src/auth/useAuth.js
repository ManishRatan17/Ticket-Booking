import { useContext } from 'react'
import { AuthContext } from './context.js'

// const { status, user, login, logout, … } = useAuth()
//   status: 'loading' (asking the server) | 'signed-in' | 'signed-out'
export function useAuth() {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth() must be used inside <AuthProvider>')
  return auth
}
