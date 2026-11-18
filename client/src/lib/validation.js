// Checks run in the browser BEFORE sending, for instant feedback.
// They mirror the server's rules, but the SERVER is the authority: it re-checks everything,
// and some rules exist only there (e.g. the list of common passwords).

export function validateEmail(email) {
  const value = email.trim()
  if (!value) return 'Email is required.'
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address.'
  return undefined
}

// Rules for CHOOSING a password (register, reset). Login only checks it isn't empty.
export function validateNewPassword(password, email = '') {
  if (password.length < 10) return 'Use at least 10 characters.'
  if (password.length > 128) return 'Use at most 128 characters.'
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) {
    return 'Your password must not be your email.'
  }
  return undefined
}

export function validateConfirmation(password, confirmation) {
  return password === confirmation ? undefined : 'The passwords do not match.'
}

// Keeps only the fields that have an error: {} means the form is valid.
export function collectErrors(errors) {
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message))
}
