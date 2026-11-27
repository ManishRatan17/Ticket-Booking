// Full-screen train scene: the rails are laid, then a high-speed train (locomotive + two coaches)
// glides across at speed, wheels turning, overhead-line poles streaming past. Inline SVG + CSS.
import { SceneBackdrop } from './SceneBackdrop.jsx'
import './TrainTransition.css'

const COACHES_X = [10, 330]
const WINDOWS = [44, 84, 124, 164, 204, 244] // per coach, left edges

function Bogie({ x }) {
  return (
    <g>
      <rect x={x - 26} y="100" width="52" height="9" rx="3" fill="var(--scene-metal)" stroke="var(--scene-tyre)" strokeWidth="1.2" />
      {[x - 14, x + 14].map((cx) => (
        <g key={cx} className="train-scene__wheel">
          <circle cx={cx} cy="112" r="8.5" fill="var(--scene-tyre)" />
          <circle cx={cx} cy="112" r="3.2" fill="var(--scene-line)" />
          <line x1={cx - 6} y1="112" x2={cx + 6} y2="112" stroke="var(--scene-metal)" strokeWidth="1.6" />
        </g>
      ))}
    </g>
  )
}

function Coach({ x }) {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect x="0" y="28" width="310" height="74" rx="12" fill="url(#train-body)" stroke="var(--scene-line)" strokeWidth="1.2" />
      <rect x="10" y="22" width="290" height="8" rx="4" fill="var(--scene-object-shade)" />
      <rect x="0" y="40" width="310" height="24" fill="url(#train-glass)" />
      {WINDOWS.map((wx) => (
        <rect key={wx} x={wx} y="43" width="32" height="18" rx="4" fill="var(--scene-dark)" stroke="var(--scene-metal)" strokeWidth="0.8" />
      ))}
      <rect x="0" y="40" width="310" height="2" fill="var(--scene-line)" opacity="0.6" />
      <rect x="0" y="72" width="310" height="6" fill="url(#train-accent)" />
      <rect x="14" y="34" width="16" height="60" rx="3" fill="none" stroke="var(--scene-line)" strokeWidth="1.2" />
      <rect x="280" y="34" width="16" height="60" rx="3" fill="none" stroke="var(--scene-line)" strokeWidth="1.2" />
      <rect x="4" y="94" width="302" height="10" rx="3" fill="var(--scene-dark)" />
      <Bogie x={58} />
      <Bogie x={252} />
    </g>
  )
}

export function TrainTransition() {
  return (
    <SceneBackdrop className="train-scene">
      <div className="train-scene__poles" />
      <div className="train-scene__rails" />

      <div className="train-scene__train">
        <svg viewBox="0 0 960 124" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="train-body" x1="0" y1="28" x2="0" y2="102" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--scene-object)" />
              <stop offset="55%" stopColor="var(--scene-object)" />
              <stop offset="100%" stopColor="var(--scene-object-shade)" />
            </linearGradient>
            <linearGradient id="train-glass" x1="0" y1="40" x2="0" y2="64" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--scene-tyre)" />
              <stop offset="100%" stopColor="var(--scene-outline)" />
            </linearGradient>
            <linearGradient id="train-accent" x1="0" y1="0" x2="960" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="var(--scene-accent)" />
              <stop offset="100%" stopColor="var(--scene-accent-2)" />
            </linearGradient>
            <radialGradient id="train-headlight">
              <stop offset="0%" stopColor="var(--scene-light)" />
              <stop offset="100%" stopColor="var(--scene-warm-soft)" stopOpacity="0" />
            </radialGradient>
          </defs>

          {COACHES_X.map((x) => (
            <Coach key={x} x={x} />
          ))}
          {/* gangways between the cars */}
          <rect x="320" y="36" width="10" height="60" fill="var(--scene-metal)" />
          <rect x="640" y="36" width="10" height="60" fill="var(--scene-metal)" />

          {/* the locomotive: a long aerodynamic nose */}
          <g>
            <path d="M676 22L700 8H760L782 22" stroke="var(--scene-dark)" strokeWidth="2" strokeLinejoin="round" />
            <rect x="690" y="5" width="80" height="4" rx="2" fill="var(--scene-dark)" />
            <path
              d="M650 28H820C872 28 908 42 936 68C948 79 952 90 946 98C943 101 938 102 932 102H650Z"
              fill="url(#train-body)"
              stroke="var(--scene-line)"
              strokeWidth="1.2"
            />
            <path d="M650 40H842L858 64H650Z" fill="url(#train-glass)" />
            {[674, 714, 754, 794].map((wx) => (
              <rect key={wx} x={wx} y="43" width="30" height="18" rx="4" fill="var(--scene-dark)" stroke="var(--scene-metal)" strokeWidth="0.8" />
            ))}
            <path d="M850 33C880 36 904 47 924 64H886C874 52 862 43 850 40Z" fill="var(--scene-outline)" stroke="var(--scene-metal)" strokeWidth="1" />
            <path d="M864 38C882 42 898 50 910 60H896C886 52 876 45 864 41Z" fill="var(--scene-glass-shine)" opacity="0.35" />
            <path d="M650 72H878C904 74 926 84 944 96L940 99C922 89 902 81 876 79H650Z" fill="url(#train-accent)" />
            <ellipse cx="934" cy="88" rx="16" ry="10" fill="url(#train-headlight)" className="train-scene__headlight" />
            <ellipse cx="934" cy="88" rx="5" ry="3" fill="var(--scene-light)" stroke="var(--scene-line)" strokeWidth="0.8" />
            <rect x="664" y="34" width="16" height="60" rx="3" fill="none" stroke="var(--scene-line)" strokeWidth="1.2" />
            <path d="M654 94H930C938 94 942 98 938 104H654Z" fill="var(--scene-dark)" />
            <Bogie x={710} />
            <Bogie x={880} />
          </g>
        </svg>
      </div>
    </SceneBackdrop>
  )
}
