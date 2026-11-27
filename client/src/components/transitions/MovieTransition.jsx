// Full-screen cinema scene: the curtains start closed and open smoothly, revealing the glowing screen
// with a seat-booking view on it (seats being picked one by one) and the projector's beam.
// Decoration only: no booking happens here.
import './MovieTransition.css'

const ROWS = 5
const SEATS_PER_ROW = 10
// Already taken, and the ones that light up as "picked" (row * 10 + seat).
const TAKEN = new Set([2, 3, 14, 15, 16, 27, 31, 32, 38, 45, 46])
const PICKED = [23, 24, 25]

export function MovieTransition() {
  const seats = Array.from({ length: ROWS * SEATS_PER_ROW }, (_, i) => i)
  return (
    <div className="movie-scene" aria-hidden="true">
      <div className="movie-scene__screen">
        <div className="movie-scene__booking">
          <div className="movie-scene__screen-label">SCREEN</div>
          <div className="movie-scene__seatmap">
            {seats.map((i) => {
              const picked = PICKED.indexOf(i)
              const kind = picked >= 0 ? 'picked' : TAKEN.has(i) ? 'taken' : 'free'
              return <span key={i} className={`movie-scene__seat movie-scene__seat--${kind}`} style={picked >= 0 ? { '--n': picked } : undefined} />
            })}
          </div>
          <div className="movie-scene__cta">Book 3 seats</div>
        </div>
      </div>
      <div className="movie-scene__beam" />
      <div className="movie-scene__seats" />
      <div className="movie-scene__curtain movie-scene__curtain--left" />
      <div className="movie-scene__curtain movie-scene__curtain--right" />
      <div className="movie-scene__valance" />
    </div>
  )
}
