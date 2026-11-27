// Full-screen flight scene: banks of cloud rise from the bottom, then an airplane (with contrails)
// climbs up through them and away, again and again until the page is ready.
import { SceneBackdrop } from './SceneBackdrop.jsx'
import './FlightTransition.css'

// Small clouds drifting up past the plane: horizontal position, delay, size.
const PUFFS = [
  { x: '8%', d: '0.2s', w: '16vw' },
  { x: '62%', d: '0.9s', w: '20vw' },
  { x: '30%', d: '1.6s', w: '13vw' },
  { x: '78%', d: '2.2s', w: '15vw' },
  { x: '45%', d: '2.9s', w: '18vw' },
]

export function FlightTransition() {
  return (
    <SceneBackdrop className="flight-scene">
      {PUFFS.map((p) => (
        <span key={p.x} className="flight-scene__puff" style={{ '--x': p.x, '--d': p.d, '--w': p.w }} />
      ))}
      <div className="flight-scene__clouds flight-scene__clouds--back" />

      <div className="flight-scene__plane">
        <svg viewBox="0 0 100 112" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M50 3C54.5 3 57 11 57 21V45L95 66V76L57 65V91L70 101V109L50 103L30 109V101L43 91V65L5 76V66L43 45V21C43 11 45.5 3 50 3Z"
            fill="var(--scene-object)"
            stroke="var(--scene-outline)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <rect x="48.6" y="26" width="2.8" height="62" rx="1.4" fill="var(--scene-accent)" opacity="0.55" />
          <path d="M46.5 12C47.5 8.5 52.5 8.5 53.5 12V17H46.5V12Z" fill="var(--scene-glass-shine)" stroke="var(--scene-outline)" strokeWidth="1.2" />
          <rect x="22" y="57" width="7" height="13" rx="3.5" fill="var(--scene-object-shade)" stroke="var(--scene-outline)" strokeWidth="1.4" />
          <rect x="71" y="57" width="7" height="13" rx="3.5" fill="var(--scene-object-shade)" stroke="var(--scene-outline)" strokeWidth="1.4" />
        </svg>
        <span className="flight-scene__trail flight-scene__trail--left" />
        <span className="flight-scene__trail flight-scene__trail--right" />
      </div>

      <div className="flight-scene__clouds flight-scene__clouds--front" />
    </SceneBackdrop>
  )
}
