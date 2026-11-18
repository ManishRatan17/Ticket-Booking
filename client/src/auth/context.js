import { createContext } from 'react'

// Shared by AuthProvider (which fills it) and useAuth (which reads it).
// Kept in its own file so component files only export components (fast refresh needs that).
export const AuthContext = createContext(null)
