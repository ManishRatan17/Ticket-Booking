// The ONE environment shared by all four category animations and the Coming soon pages: a twilight
// sky in the brand's colours, stars, a glow on the horizon, two ranges of hills drifting slowly, the
// ground. Each category only places its own moving objects inside (children). Colours: styles/tokens.css.
import './SceneBackdrop.css'

export function SceneBackdrop({ className = '', children }) {
  return (
    <div className={`scene ${className}`} aria-hidden="true">
      <div className="scene__stars" />
      <div className="scene__glow" />
      <div className="scene__hills scene__hills--far" />
      <div className="scene__hills scene__hills--near" />
      <div className="scene__ground" />
      {children}
    </div>
  )
}
