// Full-screen "Coming soon" for a category that isn't built yet (Movie, Flight): an animated
// under-construction scene, the message, and the way back home. No booking here.
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import './ComingSoon.css'

// Movie: spotlights sweeping, a clapperboard snapping, a film strip of hazard stripes rolling by.
function MovieConstruction() {
  return (
    <>
      <span className="cs-spot cs-spot--left" />
      <span className="cs-spot cs-spot--right" />
      <svg className="cs-movie__clapper" viewBox="0 0 200 150" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="30" y="58" width="140" height="84" rx="6" fill="#111827" stroke="#f8fafc" strokeWidth="2" />
        <rect x="30" y="58" width="140" height="16" fill="#1f2937" />
        {[0, 1, 2, 3, 4].map((i) => (
          <path key={i} d={`M${38 + i * 28} 58H${52 + i * 28}L${44 + i * 28} 74H${30 + i * 28}Z`} fill="#f8fafc" />
        ))}
        <rect x="44" y="86" width="70" height="6" rx="3" fill="#f8fafc" opacity="0.8" />
        <rect x="44" y="100" width="100" height="6" rx="3" fill="#f8fafc" opacity="0.5" />
        <rect x="44" y="114" width="56" height="6" rx="3" fill="#facc15" />
        <g className="cs-movie__stick">
          <rect x="30" y="38" width="140" height="18" rx="2" fill="#111827" stroke="#f8fafc" strokeWidth="2" />
          {[0, 1, 2, 3, 4].map((i) => (
            <path key={i} d={`M${44 + i * 28} 38H${58 + i * 28}L${50 + i * 28} 56H${36 + i * 28}Z`} fill="#f8fafc" />
          ))}
        </g>
        <circle cx="34" cy="57" r="4" fill="#facc15" stroke="#111827" strokeWidth="1.5" />
      </svg>
      <div className="cs-movie__film" />
    </>
  )
}

// Flight: clouds drifting, a crane lowering the tail fin onto an airliner being built, welding sparks.
function FlightConstruction() {
  return (
    <>
      <span className="cs-cloud cs-cloud--one" />
      <span className="cs-cloud cs-cloud--two" />
      <svg className="cs-flight__hangar" viewBox="0 0 400 190" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* crane: tower, jib, counterweight, trolley */}
        <path d="M44 176V30M58 176V30" stroke="#f59e0b" strokeWidth="4" />
        <path d="M44 176L58 160L44 144L58 128L44 112L58 96L44 80L58 64L44 48L58 32" stroke="#f59e0b" strokeWidth="2" />
        <rect x="14" y="24" width="190" height="8" rx="2" fill="#f59e0b" />
        <rect x="14" y="32" width="22" height="16" rx="2" fill="#475569" />
        <rect x="160" y="32" width="14" height="6" rx="1" fill="#334155" />
        {/* the cable reaches exactly down to the fin as both move (same timing) */}
        <line className="cs-flight__cable" x1="167" y1="38" x2="167" y2="76" stroke="#334155" strokeWidth="1.5" />
        <g className="cs-flight__fin">
          <path d="M163 76H171V82H163Z" fill="#334155" />
          <path d="M150 112L162 82H176L178 112Z" fill="#e2e8f0" stroke="#0f172a" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M158 104L166 86H172L172 104Z" fill="#2563eb" opacity="0.7" />
        </g>

        {/* the airliner on its assembly stands */}
        <path d="M150 140L158 176M166 140L158 176M300 140L292 176M284 140L292 176" stroke="#64748b" strokeWidth="3" />
        <path
          d="M140 112H330C352 112 368 118 376 126C368 134 352 140 330 140H162C150 140 142 136 138 128Z"
          fill="#f8fafc"
          stroke="#0f172a"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M120 114L146 120L148 130L124 124Z" fill="#e2e8f0" stroke="#0f172a" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M228 130L276 162H292L266 130Z" fill="#e2e8f0" stroke="#0f172a" strokeWidth="1.6" strokeLinejoin="round" />
        <rect x="246" y="140" width="32" height="12" rx="6" fill="#cbd5e1" stroke="#0f172a" strokeWidth="1.4" />
        {[184, 198, 212, 226, 240, 254, 268, 282, 296, 310].map((x) => (
          <circle key={x} cx={x} cy="122" r="2.6" fill="#38bdf8" stroke="#0f172a" strokeWidth="0.8" />
        ))}
        <path d="M350 117L364 122L358 125L346 123Z" fill="#0f172a" />
        <rect x="160" y="130" width="168" height="3" fill="#2563eb" opacity="0.7" />
        {/* sparks where the fin meets the body */}
        {[0, 1, 2, 3, 4].map((i) => (
          <circle key={i} className="cs-flight__spark" style={{ '--i': i }} cx="164" cy="112" r="1.8" fill="#fde047" />
        ))}
        {/* hazard barrier on the ground */}
        <rect x="0" y="176" width="400" height="14" fill="url(#cs-hazard)" />
        <defs>
          <pattern id="cs-hazard" width="20" height="14" patternUnits="userSpaceOnUse" patternTransform="skewX(-35)">
            <rect width="10" height="14" fill="#facc15" />
            <rect x="10" width="10" height="14" fill="#111827" />
          </pattern>
        </defs>
      </svg>
    </>
  )
}

export function ComingSoon({ category }) {
  // Full screen: the page behind doesn't scroll while this is shown.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <section className={`coming-soon coming-soon--${category.key} category--${category.key}`} aria-labelledby="coming-soon-title">
      <div className="coming-soon__scene" aria-hidden="true">
        {category.key === 'movie' ? <MovieConstruction /> : <FlightConstruction />}
      </div>

      <div className="coming-soon__card">
        <span className="coming-soon__badge">
          <span aria-hidden="true">{category.emoji}</span> {category.label} · Coming soon
        </span>
        <h1 id="coming-soon-title">We're building something exciting!</h1>
        <p className="muted">
          {category.label} tickets aren't bookable yet. We're putting the finishing touches on it; until then, trains and
          buses are ready to book.
        </p>
        <div className="coming-soon__progress" aria-hidden="true">
          <span />
        </div>
        <Link to="/" className="button">
          ← Back to Home
        </Link>
      </div>
    </section>
  )
}
