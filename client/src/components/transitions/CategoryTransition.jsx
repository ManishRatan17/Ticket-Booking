// The full-screen overlay while a category opens: its animation, then (if it takes long) a normal
// loading state, or an error with Try again. Timing is decided by useCategoryTransition.
import { useEffect, useRef } from 'react'
import { TrainTransition } from './TrainTransition.jsx'
import { BusTransition } from './BusTransition.jsx'
import { MovieTransition } from './MovieTransition.jsx'
import { FlightTransition } from './FlightTransition.jsx'
import './CategoryTransition.css'

const SCENES = { train: TrainTransition, bus: BusTransition, movie: MovieTransition, flight: FlightTransition }

export function CategoryTransition({ category, phase, error, onRetry, onCancel }) {
  const overlay = useRef(null)

  // While it's open: the page behind doesn't scroll, and keyboard / screen-reader focus is on it.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    overlay.current?.focus()
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const Scene = SCENES[category.key]
  const playing = phase === 'animating' || phase === 'leaving'

  function handleKeyDown(e) {
    if (e.key === 'Escape' && !playing) onCancel()
  }

  return (
    <div
      ref={overlay}
      tabIndex={-1}
      className={`ct-overlay ct-overlay--${phase}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Opening ${category.label}`}
      onKeyDown={handleKeyDown}
      style={{ '--ct-fade-delay': `${Math.max(0, category.exitMs - 450)}ms` }}
    >
      {playing && (
        <div className="ct-scene">
          <Scene leaving={phase === 'leaving'} />
          <p className="ct-caption" role="status">
            Opening {category.label}…
          </p>
        </div>
      )}

      {phase === 'waiting' && (
        <div className="ct-status" role="status">
          <div className="ct-spinner" aria-hidden="true" />
          <h2>Still loading {category.label}…</h2>
          <p className="muted">This is taking longer than usual.</p>
          <div className="ct-status__actions">
            <button type="button" className="button button-secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="ct-status" role="alert">
          <div className="ct-status__icon" aria-hidden="true">
            {category.emoji}
          </div>
          <h2>Couldn't open {category.label}</h2>
          <p className="muted">{error}</p>
          <div className="ct-status__actions">
            <button type="button" className="button" onClick={onRetry}>
              Try again
            </button>
            <button type="button" className="button button-secondary" onClick={onCancel}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
