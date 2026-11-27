// Admin → Trips: add bus trips and trains (the platform's own inventory), and see what's coming up.
import { useCallback, useEffect, useState } from 'react'
import { adminTrips } from '../api/bookings.js'
import { withFreshRole } from '../api/admin.js'
import { Alert } from '../components/Alert.jsx'
import { FormField } from '../components/FormField.jsx'
import { errorMessage, fieldErrors } from '../lib/errorMessages.js'
import { formatDate, formatMoney } from '../lib/format.js'
import { CLASS_NAMES } from '../lib/booking.js'

const busApi = adminTrips('bus')
const trainApi = adminTrips('train')
const iso = (local) => (local ? new Date(local).toISOString() : '')
const paise = (rupees) => Math.round(Number(rupees) * 100)

export function AdminTripsPage() {
  const [buses, setBuses] = useState(null)
  const [trains, setTrains] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    withFreshRole(() => busApi.list()).then((r) => setBuses(r.trips), (err) => setError(errorMessage(err)))
    withFreshRole(() => trainApi.list()).then((r) => setTrains(r.trips), (err) => setTrains({ error: errorMessage(err) }))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  return (
    <section>
      <h1>Trips</h1>
      <p className="muted">The platform's own buses and trains. Customers find them under Bus and Train.</p>
      <Alert>{error}</Alert>
      <div className="admin-trips">
        <BusTripForm onCreated={load} />
        <TrainTripForm onCreated={load} />
      </div>

      <h2>Upcoming buses</h2>
      {buses === null ? (
        <p className="muted">Loading…</p>
      ) : buses.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Route</th>
                <th>Departs</th>
                <th>Operator</th>
                <th>Fare</th>
                <th>Seats left</th>
              </tr>
            </thead>
            <tbody>
              {buses.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.from} → {t.to}
                  </td>
                  <td>{formatDate(t.departsAt)}</td>
                  <td>
                    {t.operator} · {t.busNumber}
                  </td>
                  <td>{formatMoney(t.farePaise)}</td>
                  <td>
                    {t.seatsLeft} / {t.totalSeats}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Upcoming trains</h2>
      {trains === null ? (
        <p className="muted">Loading…</p>
      ) : trains.error ? (
        <Alert>{trains.error}</Alert>
      ) : trains.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Train</th>
                <th>Route</th>
                <th>Departs</th>
                <th>Classes (left / total)</th>
              </tr>
            </thead>
            <tbody>
              {trains.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.trainNumber} · {t.trainName}
                  </td>
                  <td>
                    {t.from} → {t.to}
                  </td>
                  <td>{formatDate(t.departsAt)}</td>
                  <td>{t.classes.map((c) => `${c.code} ${c.available}/${c.total}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function useForm(initial) {
  const [form, setForm] = useState(initial)
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }))
  return [form, set, setForm]
}

function BusTripForm({ onCreated }) {
  const [form, set, setForm] = useForm({ operator: '', busNumber: '', from: '', to: '', departsAt: '', arrivesAt: '', fare: '', rows: '10', seatColumns: 'ABCD' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    setError(null)
    setNotice(null)
    try {
      const { trip } = await busApi.create({
        operator: form.operator,
        busNumber: form.busNumber,
        from: form.from,
        to: form.to,
        departsAt: iso(form.departsAt),
        arrivesAt: iso(form.arrivesAt),
        farePaise: paise(form.fare),
        rows: Number(form.rows),
        seatColumns: form.seatColumns.toUpperCase(),
      })
      setNotice(`Added: ${trip.from} → ${trip.to}, ${trip.totalSeats} seats.`)
      setForm((f) => ({ ...f, departsAt: '', arrivesAt: '' }))
      onCreated()
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel category--bus" onSubmit={submit} noValidate>
      <h2>🚌 Add a bus trip</h2>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <div className="form-grid">
        <FormField id="bus-operator" label="Operator" value={form.operator} onChange={set('operator')} error={errors.operator} />
        <FormField id="bus-number" label="Bus number" value={form.busNumber} onChange={set('busNumber')} error={errors.busNumber} />
        <FormField id="bus-from" label="From" value={form.from} onChange={set('from')} error={errors.from} />
        <FormField id="bus-to" label="To" value={form.to} onChange={set('to')} error={errors.to} />
        <FormField id="bus-departs" label="Departs" type="datetime-local" value={form.departsAt} onChange={set('departsAt')} error={errors.departsAt} />
        <FormField id="bus-arrives" label="Arrives" type="datetime-local" value={form.arrivesAt} onChange={set('arrivesAt')} error={errors.arrivesAt} />
        <FormField id="bus-fare" label="Fare per seat (₹)" type="number" min="0" step="0.01" value={form.fare} onChange={set('fare')} error={errors.farePaise} />
        <FormField id="bus-rows" label="Rows" type="number" min="1" max="15" value={form.rows} onChange={set('rows')} error={errors.rows} />
        <FormField id="bus-columns" label="Seat columns" hint="Letters A–F, e.g. ABCD = 2 + 2" value={form.seatColumns} onChange={set('seatColumns')} error={errors.seatColumns} />
      </div>
      <button type="submit" className="button" disabled={busy}>
        {busy ? 'Adding…' : 'Add bus trip'}
      </button>
    </form>
  )
}

const CLASS_DEFAULTS = { '1A': [450_000, 1, 18], '2A': [280_000, 2, 46], '3A': [190_000, 3, 64], SL: [75_000, 4, 72], CC: [95_000, 2, 78], '2S': [30_000, 2, 80] }

function TrainTripForm({ onCreated }) {
  const [form, set, setForm] = useForm({ trainNumber: '', trainName: '', from: '', to: '', departsAt: '', arrivesAt: '' })
  const [classes, setClasses] = useState(() =>
    Object.fromEntries(Object.entries(CLASS_DEFAULTS).map(([code, [fare, coaches, berths]]) => [code, { on: code === '3A' || code === 'SL', fare: String(fare / 100), coaches: String(coaches), berths: String(berths) }])),
  )
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const setClass = (code, name) => (e) => setClasses((c) => ({ ...c, [code]: { ...c[code], [name]: name === 'on' ? e.target.checked : e.target.value } }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    setError(null)
    setNotice(null)
    try {
      const { trip } = await trainApi.create({
        trainNumber: form.trainNumber,
        trainName: form.trainName,
        from: form.from,
        to: form.to,
        departsAt: iso(form.departsAt),
        arrivesAt: iso(form.arrivesAt),
        classes: Object.entries(classes)
          .filter(([, c]) => c.on)
          .map(([code, c]) => ({ code, farePaise: paise(c.fare), coaches: Number(c.coaches), berthsPerCoach: Number(c.berths) })),
      })
      setNotice(`Added: ${trip.trainNumber} ${trip.trainName}, ${trip.classes.map((c) => `${c.code} ${c.total}`).join(', ')}.`)
      setForm((f) => ({ ...f, departsAt: '', arrivesAt: '' }))
      onCreated()
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel category--train" onSubmit={submit} noValidate>
      <h2>🚆 Add a train</h2>
      <Alert>{error}</Alert>
      <Alert kind="success">{notice}</Alert>
      <div className="form-grid">
        <FormField id="train-number" label="Train number" hint="4–5 digits" value={form.trainNumber} onChange={set('trainNumber')} error={errors.trainNumber} />
        <FormField id="train-name" label="Train name" value={form.trainName} onChange={set('trainName')} error={errors.trainName} />
        <FormField id="train-from" label="From" value={form.from} onChange={set('from')} error={errors.from} />
        <FormField id="train-to" label="To" value={form.to} onChange={set('to')} error={errors.to} />
        <FormField id="train-departs" label="Departs" type="datetime-local" value={form.departsAt} onChange={set('departsAt')} error={errors.departsAt} />
        <FormField id="train-arrives" label="Arrives" type="datetime-local" value={form.arrivesAt} onChange={set('arrivesAt')} error={errors.arrivesAt} />
      </div>
      <fieldset className="class-picker">
        <legend>Classes (fare ₹ · coaches · berths per coach)</legend>
        {Object.entries(classes).map(([code, c]) => (
          <div key={code} className="class-picker__row">
            <label>
              <input type="checkbox" checked={c.on} onChange={setClass(code, 'on')} /> <strong>{code}</strong> <span className="muted">{CLASS_NAMES[code]}</span>
            </label>
            <input aria-label={`${code} fare`} type="number" min="0" value={c.fare} onChange={setClass(code, 'fare')} disabled={!c.on} />
            <input aria-label={`${code} coaches`} type="number" min="1" max="24" value={c.coaches} onChange={setClass(code, 'coaches')} disabled={!c.on} />
            <input aria-label={`${code} berths per coach`} type="number" min="1" max="80" value={c.berths} onChange={setClass(code, 'berths')} disabled={!c.on} />
          </div>
        ))}
        {errors.classes && <p className="field-error">{errors.classes}</p>}
      </fieldset>
      <button type="submit" className="button" disabled={busy}>
        {busy ? 'Adding…' : 'Add train'}
      </button>
    </form>
  )
}
