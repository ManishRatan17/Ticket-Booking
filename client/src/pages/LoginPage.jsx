import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { FormField } from '../components/FormField.jsx'
import { Alert } from '../components/Alert.jsx'
import { GoogleButton } from '../components/GoogleButton.jsx'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { validateEmail, collectErrors } from '../lib/validation.js'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault() // stop the browser's own form submit (a full page reload)
    const found = collectErrors({
      email: validateEmail(email),
      password: password ? undefined : 'Password is required.',
    })
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return

    setSubmitting(true)
    try {
      await login(email, password)
      // Back to the page that sent us here (RequireAuth puts it in state), or home.
      navigate(location.state?.from ?? '/', { replace: true })
    } catch (err) {
      setErrors(fieldErrors(err))
      setFormError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="card">
      <h1>Log in</h1>
      <Alert kind="success">{location.state?.notice}</Alert>
      <Alert>{formError}</Alert>

      <form onSubmit={handleSubmit} noValidate>
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>

      <p>
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      <div className="divider">or</div>
      <GoogleButton />
      <p className="muted">
        New here? <Link to="/register">Create an account</Link>
      </p>
    </section>
  )
}
