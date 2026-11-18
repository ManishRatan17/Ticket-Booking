import { useState } from 'react'
import { Link } from 'react-router-dom'
import { forgotPassword } from '../api/auth.js'
import { FormField } from '../components/FormField.jsx'
import { Alert } from '../components/Alert.jsx'
import { errorMessage } from '../lib/errorMessages.js'
import { validateEmail } from '../lib/validation.js'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [sent, setSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    const problem = validateEmail(email)
    setError(problem ?? null)
    if (problem) return

    setSubmitting(true)
    try {
      await forgotPassword(email)
      setSent(true)
    } catch (err) {
      setError(errorMessage(err)) // e.g. 429 "Too many attempts. Try again in 58 minutes."
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    // The same words whether or not the account exists — the server can't tell us, on purpose.
    return (
      <section className="card">
        <h1>Check your email</h1>
        <p>
          If an account exists for <strong>{email.trim()}</strong>, we have sent a link to reset the password. The link
          works once, for 15 minutes.
        </p>
        <p className="muted">
          (In development the email is printed in the server terminal.) <Link to="/login">Back to log in</Link>
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <h1>Forgot your password?</h1>
      <p className="muted">Enter your email and we'll send you a link to choose a new one.</p>
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
        />
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p>
        <Link to="/login">Back to log in</Link>
      </p>
    </section>
  )
}
