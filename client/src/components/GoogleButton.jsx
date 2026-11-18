import { GOOGLE_SIGN_IN_URL } from '../api/auth.js'

// A plain link, not fetch(): the whole browser has to travel to Google and back.
export function GoogleButton() {
  return (
    <a className="button button-secondary google-button" href={GOOGLE_SIGN_IN_URL}>
      Continue with Google
    </a>
  )
}
