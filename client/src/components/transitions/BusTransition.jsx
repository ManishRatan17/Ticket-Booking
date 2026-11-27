// Full-screen bus scene: the road appears, the bus drives in and keeps going (lane markings and the
// city stream past), with dust from the wheels and exhaust smoke behind it. CSS animations only.
import { SceneBackdrop } from './SceneBackdrop.jsx'
import './BusTransition.css'

const WINDOWS_X = [22, 64, 106, 148]
const WHEELS_X = [62, 196]
const PUFFS = [0, 1, 2, 3]

// leaving = the page is ready: the bus accelerates away to the right.
export function BusTransition({ leaving = false }) {
  return (
    <SceneBackdrop className={leaving ? 'bus-scene bus-scene--leaving' : 'bus-scene'}>
      <div className="bus-scene__road">
        <div className="bus-scene__lane" />
      </div>

      <div className="bus-scene__vehicle">
        <div className="bus-scene__dust">
          {PUFFS.map((i) => (
            <span key={i} style={{ '--i': i }} />
          ))}
        </div>
        <div className="bus-scene__smoke">
          {PUFFS.map((i) => (
            <span key={i} style={{ '--i': i }} />
          ))}
        </div>

        <svg className="bus-scene__bus" viewBox="0 0 260 112" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g className="bus-scene__body">
            <rect x="8" y="12" width="240" height="80" rx="14" fill="var(--scene-object)" stroke="var(--scene-outline)" strokeWidth="2" />
            <rect x="16" y="17" width="224" height="9" rx="4.5" fill="var(--scene-object-shade)" />
            <rect x="8" y="66" width="240" height="8" fill="var(--scene-accent)" />
            {WINDOWS_X.map((x) => (
              <g key={x}>
                <rect x={x} y="31" width="36" height="27" rx="4" fill="var(--scene-glass)" stroke="var(--scene-outline)" strokeWidth="1.5" />
                <path d={`M${x + 5} ${55}L${x + 17} ${34}H${x + 23}L${x + 11} ${55}Z`} fill="var(--scene-glass-shine)" opacity="0.35" />
              </g>
            ))}
            {/* door */}
            <rect x="190" y="31" width="23" height="54" rx="3" fill="var(--scene-glass)" stroke="var(--scene-outline)" strokeWidth="1.5" />
            <line x1="201.5" y1="31" x2="201.5" y2="85" stroke="var(--scene-outline)" strokeWidth="1.2" />
            {/* windscreen (the front is on the right) */}
            <path d="M219 31H234C240.6 31 245 35.4 245 42V60H219V31Z" fill="var(--scene-glass-shine)" stroke="var(--scene-outline)" strokeWidth="1.5" />
            <rect x="236" y="74" width="10" height="8" rx="2" fill="var(--scene-light)" stroke="var(--scene-outline)" strokeWidth="1.2" />
            <rect x="8" y="74" width="6" height="10" rx="1.5" fill="var(--scene-signal)" />
            {/* wheel arches */}
            {WHEELS_X.map((cx) => (
              <path key={cx} d={`M${cx - 20} 92A20 20 0 0 1 ${cx + 20} 92Z`} fill="var(--scene-outline)" />
            ))}
          </g>
          {WHEELS_X.map((cx) => (
            <g key={cx} className="bus-scene__wheel">
              <circle cx={cx} cy="94" r="15" fill="var(--scene-tyre)" />
              <circle cx={cx} cy="94" r="7" fill="var(--scene-hub)" />
              <line x1={cx - 7} y1="94" x2={cx + 7} y2="94" stroke="var(--scene-dark)" strokeWidth="2" />
              <line x1={cx} y1="87" x2={cx} y2="101" stroke="var(--scene-dark)" strokeWidth="2" />
            </g>
          ))}
        </svg>
      </div>
    </SceneBackdrop>
  )
}
