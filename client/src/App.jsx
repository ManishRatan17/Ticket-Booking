// The app's pages and who may see them. Everything about HOW we talk to the server lives
// in src/api/; everything about WHO is signed in lives in src/auth/.
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './App.css'
import { AuthProvider } from './auth/AuthProvider.jsx'
import { GuestOnly, RequireAuth } from './auth/guards.jsx'
import { Layout } from './components/Layout.jsx'
import { HomePage } from './pages/HomePage.jsx'
import { LoginPage } from './pages/LoginPage.jsx'
import { RegisterPage } from './pages/RegisterPage.jsx'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.jsx'
import { ResetPasswordPage } from './pages/ResetPasswordPage.jsx'
import { NotFoundPage } from './pages/NotFoundPage.jsx'
import { AccountPage } from './pages/AccountPage.jsx'

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />

            {/* Only for signed-out visitors */}
            <Route element={<GuestOnly />}>
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="forgot-password" element={<ForgotPasswordPage />} />
            </Route>

            {/* Signed-in users only (the server checks again on every request) */}
            <Route element={<RequireAuth />}>
              <Route path="account" element={<AccountPage />} />
            </Route>

            {/* Reachable either way: the link comes from an email */}
            <Route path="reset-password" element={<ResetPasswordPage />} />

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
