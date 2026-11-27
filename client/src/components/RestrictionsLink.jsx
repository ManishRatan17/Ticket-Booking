// The admin's "Restrictions" link, with a badge for NEW automatic restrictions (bot strikes):
// "Restrictions (2 new)". Asks every 30 seconds, and at once when the Restrictions page marks
// them as seen (it sends a 'restrictions-seen' event).
import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { getNotifications } from '../api/admin.js'

export function RestrictionsLink({ icon }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let active = true
    const refresh = () => getNotifications().then((n) => active && setCount(n.count), () => {})
    refresh()
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('restrictions-seen', refresh)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('restrictions-seen', refresh)
    }
  }, [])

  return (
    <NavLink to="/admin/restrictions" title={count ? `${count} new bot strike${count > 1 ? 's' : ''}` : undefined}>
      {icon && <span aria-hidden="true">{icon}</span>} Restrictions{count > 0 && <span className="badge badge-alert">{count} new</span>}
    </NavLink>
  )
}
