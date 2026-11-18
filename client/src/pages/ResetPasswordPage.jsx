import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { resetPassword } from '../api/auth.js'
import { useAuth } from '../auth/useAuth.js'
import { FormField } from '../components/FormField.jsx'
import { Alert } from '../components/Alert.jsx'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { validateNewPassword, validateConfirmation, collectErrors } from '../lib/validation.js'

// The emailed link is  /reset-password#token=…  — the token is in the #fragment, which the
// browser never sends to any server. Only this page's JavaScript can read it.
function readTokenFromHash() {
  return new URLSearchParams(window.location.hash.slice(1)).get('token')
}

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const { reload } = useAuth()
  const [token] = useState(readTokenFromHash)
  const [form, setForm] = useState({ password: '', confirm: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  // Remove the token from the address bar (and so from browser history) once we have it.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
  }, [])

  const update = (name) => (event) => setForm({ ...form, [name]: event.target.value })

  async function handleSubmit(event) {
    event.preventDefault()
    const found = collectErrors({
      password: validateNewPassword(form.password),
      confirm: validateConfirmation(form.password, form.confirm),
    })
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return

    setSubmitting(true)
    try {
      await resetPassword(token, form.password)
      await reload() // the reset ended every session, including this browser's
      navigate('/login', { replace: true, state: { notice: 'Password changed. Log in with your new password.' } })
    } catch (err) {
      setErrors(fieldErrors(err))
      setFormError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <section className="card">
        <h1>Reset your password</h1>
        <Alert>This page needs the link from your email. Request a new one if it's missing.</Alert>
        <Link to="/forgot-password">Request a reset link</Link>
      </section>
    )
  }

  return (
    <section className="card">
      <h1>Choose a new password</h1>
      <Alert>{formError}</Alert>
      {formError && (
        <p>
          <Link to="/forgot-password">Request a new link</Link>
        </p>
      )}
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
          hint="At least 10 characters. Every device will be signed out."
        />
        <FormField
          id="confirm"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={update('confirm')}
          error={errors.confirm}
        />
        <button type="submit" className="button" disabled={submitting}>
          {submitting ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  )
}
