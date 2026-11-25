import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { FormField } from '../components/FormField.jsx'
import { Alert } from '../components/Alert.jsx'
import { GoogleButton } from '../components/GoogleButton.jsx'
import { TurnstileWidget } from '../components/TurnstileWidget.jsx'
import { useHumanCheck } from '../hooks/useHumanCheck.js'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { validateEmail, validateNewPassword, validateConfirmation, collectErrors } from '../lib/validation.js'

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  // website = the honeypot: hidden from people, so only bots fill it in (Phase 5d)
  const [form, setForm] = useState({ email: '', password: '', confirm: '', website: '' })
  const human = useHumanCheck()
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const update = (name) => (event) => setForm({ ...form, [name]: event.target.value })

  async function handleSubmit(event) {
    event.preventDefault()
    const found = collectErrors({
      email: validateEmail(form.email),
      password: validateNewPassword(form.password, form.email),
      confirm: validateConfirmation(form.password, form.confirm),
    })
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return

    setSubmitting(true)
    try {
      // creates the account, then signs in
      await register(form.email, form.password, { botToken: human.token, website: form.website })
      navigate('/', { replace: true })
    } catch (err) {
      // e.g. the server's common-password check, which the browser doesn't have
      setErrors(fieldErrors(err))
      setFormError(errorMessage(err))
      human.reset() // the token may have been used: get a fresh one for the next try
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="card">
      <h1>Create an account</h1>
      <Alert>{formError}</Alert>

      <form onSubmit={handleSubmit} noValidate>
        <FormField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={update('email')}
          error={errors.email}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
          hint="At least 10 characters. A short sentence is easy to remember and hard to guess."
        />
        <FormField
          id="confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={form.confirm}
          onChange={update('confirm')}
          error={errors.confirm}
        />
        {/* Honeypot: off-screen and skipped by Tab and screen readers. People leave it empty. */}
        <div className="honeypot" aria-hidden="true">
          <label htmlFor="website">Website</label>
          <input id="website" name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={update('website')} />
        </div>
        {human.siteKey && <TurnstileWidget key={human.round} siteKey={human.siteKey} onToken={human.setToken} />}
        <button type="submit" className="button" disabled={submitting || !human.ready}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <div className="divider">or</div>
      <GoogleButton />
      <p className="muted">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </section>
  )
}
