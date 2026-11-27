// One row of details per seat / traveller, and a contact phone. Checked here first (like the server,
// which checks again); the server's own errors are shown too.
import { useState } from 'react'
import { PHONE, passengerErrors } from '../../lib/booking.js'

// slots: [{ key, label }] e.g. bus seats "Seat 2C", train travellers "Traveller 1 (berth B1-3)"
export function PassengerForm({ slots, initial = [], initialPhone = '', busy = false, submitLabel, onSubmit }) {
  const [rows, setRows] = useState(() => slots.map((_, i) => ({ name: '', age: '', gender: '', ...(initial[i] ?? {}) })))
  const [phone, setPhone] = useState(initialPhone ?? '')
  const [errors, setErrors] = useState({})

  const set = (i, name) => (e) => setRows(rows.map((r, j) => (j === i ? { ...r, [name]: e.target.value } : r)))

  function submit(e) {
    e.preventDefault()
    const found = passengerErrors(rows)
    if (phone && !PHONE.test(phone.trim())) found.phone = 'A phone number, e.g. +91 98765 43210'
    setErrors(found)
    if (Object.keys(found).length) return
    onSubmit({
      passengers: rows.map((r) => ({ name: r.name.trim(), age: Number(r.age), gender: r.gender })),
      contactPhone: phone.trim() || undefined,
    })
  }

  return (
    <form className="passenger-form" onSubmit={submit} noValidate>
      {slots.map((slot, i) => (
        <fieldset key={slot.key} className="passenger">
          <legend>{slot.label}</legend>
          <div className="passenger__fields">
            <div className="field passenger__name">
              <label htmlFor={`p${i}-name`}>Full name</label>
              <input id={`p${i}-name`} value={rows[i].name} onChange={set(i, 'name')} aria-invalid={errors[`${i}.name`] ? 'true' : undefined} />
              {errors[`${i}.name`] && <p className="field-error">{errors[`${i}.name`]}</p>}
            </div>
            <div className="field passenger__age">
              <label htmlFor={`p${i}-age`}>Age</label>
              <input id={`p${i}-age`} type="number" min="1" max="120" value={rows[i].age} onChange={set(i, 'age')} aria-invalid={errors[`${i}.age`] ? 'true' : undefined} />
              {errors[`${i}.age`] && <p className="field-error">{errors[`${i}.age`]}</p>}
            </div>
            <div className="field passenger__gender">
              <label htmlFor={`p${i}-gender`}>Gender</label>
              <select id={`p${i}-gender`} value={rows[i].gender} onChange={set(i, 'gender')} aria-invalid={errors[`${i}.gender`] ? 'true' : undefined}>
                <option value="">Choose…</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </select>
              {errors[`${i}.gender`] && <p className="field-error">{errors[`${i}.gender`]}</p>}
            </div>
          </div>
        </fieldset>
      ))}
      <div className="field">
        <label htmlFor="contactPhone">Contact phone (optional)</label>
        <input id="contactPhone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
        {errors.phone && <p className="field-error">{errors.phone}</p>}
      </div>
      <button type="submit" className="button" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  )
}
