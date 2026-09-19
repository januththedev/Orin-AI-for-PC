import type { ModelInfo } from '../bridge/types'
import { OrinMark } from './OrinMark'
import './StealthModal.css'

export function StealthModal({
  models,
  onUse,
  onDismiss,
}: {
  models: ModelInfo[]
  onUse: (model: ModelInfo) => void
  onDismiss: () => void
}) {
  if (models.length === 0) return null
  const [first, ...rest] = models
  return (
    <div className="stealth-overlay" role="dialog" aria-label="New free model available">
      <div className="stealth-card">
        <OrinMark size={52} state="thinking" />
        <p className="stealth-kicker">New free stealth model{models.length > 1 ? 's' : ''} just landed</p>
        <h2 className="stealth-title">{first.label}</h2>
        <p className="stealth-id">{first.id}</p>
        {rest.length > 0 && (
          <ul className="stealth-more">
            {rest.slice(0, 4).map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onUse(m)}>
                  {m.label}
                </button>
              </li>
            ))}
            {rest.length > 4 && <li>…and {rest.length - 4} more in the model picker</li>}
          </ul>
        )}
        <div className="stealth-actions">
          <button type="button" className="button-primary" onClick={() => onUse(first)}>
            Use it now
          </button>
          <button type="button" className="connect-button" onClick={onDismiss}>
            Later
          </button>
        </div>
        <p className="stealth-note">Spotted live on OpenRouter · free tier · router already knows about it</p>
      </div>
    </div>
  )
}
