// Where the person is in a booking: Choose → Details → Pay → Confirmed.
const STEPS = [
  { key: 'seats', bus: 'Seats', train: 'Class' },
  { key: 'details', bus: 'Passengers', train: 'Travellers' },
  { key: 'pay', bus: 'Payment', train: 'Payment' },
  { key: 'done', bus: 'Confirmed', train: 'Confirmed' },
]

export function BookingSteps({ current, kind }) {
  const at = STEPS.findIndex((s) => s.key === current)
  return (
    <ol className="booking-steps" aria-label="Booking steps">
      {STEPS.map((s, i) => (
        <li key={s.key} className={i < at ? 'is-done' : i === at ? 'is-current' : undefined} aria-current={i === at ? 'step' : undefined}>
          <span className="booking-steps__dot" aria-hidden="true">
            {i < at ? '✓' : i + 1}
          </span>
          <span className="booking-steps__label">{s[kind]}</span>
        </li>
      ))}
    </ol>
  )
}
