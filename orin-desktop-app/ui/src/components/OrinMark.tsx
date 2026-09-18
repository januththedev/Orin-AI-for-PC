// Single continuous Orin bolt mark shared by the app UI and Windows assets.
// Ambient glow, rings, and sweep highlight animate while a response streams.
import type { CSSProperties } from 'react'

export function OrinMark({
  state = 'idle',
  size = 28,
  accent = 'var(--accent)',
}: {
  state?: 'idle' | 'thinking'
  size?: number
  accent?: string
}) {
  const isThinking = state === 'thinking'
  const wrap: CSSProperties = {
    width: size,
    height: size,
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  return (
    <span className="orin-mark" style={wrap} aria-label="Orin Code">
      <style>{`
        @keyframes orin-breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.04); opacity: .92; } }
        @keyframes orin-flicker { 0%, 100% { opacity: 1; filter: brightness(1); } 40% { opacity: .7; filter: brightness(1.3); } 70% { opacity: .85; filter: brightness(1.1); } }
        @keyframes orin-ring { 0% { transform: scale(.5); opacity: .5; } 100% { transform: scale(2.2); opacity: 0; } }
        @keyframes orin-glow-pulse { 0%, 100% { opacity: .15; transform: scale(1); } 50% { opacity: .35; transform: scale(1.1); } }
        @keyframes orin-sweep { 0% { transform: translateX(-100%) rotate(25deg); opacity: 0; } 30% { opacity: .6; } 100% { transform: translateX(200%) rotate(25deg); opacity: 0; } }
      `}</style>

      <span
        className="orin-glow"
        style={{
          position: 'absolute',
          inset: -size * 0.3,
          borderRadius: '50%',
          background: 'radial-gradient(circle, var(--accent-soft) 0%, transparent 70%)',
          animation: isThinking ? 'orin-glow-pulse 1.6s ease-in-out infinite' : 'orin-glow-pulse 4s ease-in-out infinite',
          pointerEvents: 'none',
        }}
      />

      {isThinking &&
        [0, 1, 2].map((i) => (
          <span
            key={i}
            className="orin-ring"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: `1.5px solid ${accent}`,
              opacity: 0,
              animation: 'orin-ring 2s ease-out infinite',
              animationDelay: `${i * 0.65}s`,
              pointerEvents: 'none',
            }}
          />
        ))}

      <svg viewBox="0 0 120 120" width={size} height={size} style={{ position: 'relative', zIndex: 1, overflow: 'visible' }}>
        <rect x="4" y="4" width="112" height="112" rx="26" fill="#1c1c1a" />
        <path
          d="M69 20 L38 66 L58 66 L50 100 L86 54 L64 54 Z"
          fill={accent}
          style={{
            transformOrigin: 'center',
            animation: isThinking ? 'orin-flicker 1.2s ease-in-out infinite' : 'orin-breathe 3.5s ease-in-out infinite',
          }}
        />
        {isThinking && (
          <>
            <clipPath id="bolt-clip">
              <path d="M69 20 L38 66 L58 66 L50 100 L86 54 L64 54 Z" />
            </clipPath>
            <rect x="-20" y="0" width="30" height="120" fill="rgba(255,255,255,.3)" clipPath="url(#bolt-clip)" style={{ animation: 'orin-sweep 2s ease-in-out infinite' }} />
          </>
        )}
      </svg>
    </span>
  )
}
