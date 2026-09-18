import { useEffect, useState } from 'react'
import Layout from './app/Layout'
import WelcomePage from './features/welcome/WelcomePage'
import { bridge } from './bridge/client'
import { useUiStore } from './stores/uiStore'
import { useAuthStore } from './stores/authStore'

type Phase = 'booting' | 'welcome' | 'app'

export default function App() {
  const hydrateAll = useUiStore((state) => state.hydrateAll)
  const [phase, setPhase] = useState<Phase>('booting')

  useEffect(() => {
    let alive = true
    ;(async () => {
      await hydrateAll()
      // Auth is not part of hydrateAll — the welcome gate needs it first.
      await useAuthStore.getState().hydrate()
      const signedIn = useAuthStore.getState().status?.signedIn ?? false
      // Any stored provider key counts — the preset catalog (P2 router) can
      // grow, so ask the core which providers take keys instead of hardcoding.
      // `openai_compat` is the legacy keyring slot, kept for older installs.
      let hasKey = false
      try {
        const providers = await bridge.providersList()
        const ids = providers.length > 0
          ? providers.filter((p) => p.keyRequired).map((p) => p.id)
          : ['anthropic', 'openai_compat']
        for (const id of [...ids, 'openai_compat']) {
          try {
            if (await bridge.providerHasKey(id)) { hasKey = true; break }
          } catch { /* try next slot */ }
        }
      } catch {
        hasKey = false
      }
      const dismissed = await bridge
        .storeGet<number>('onboarding.dismissed')
        .then((value) => value === 1)
        .catch(() => false)
      if (!alive) return
      setPhase(!signedIn && !hasKey && !dismissed ? 'welcome' : 'app')
    })().catch(() => {
      if (alive) setPhase('app') // never trap the user behind a boot failure
    })
    return () => {
      alive = false
    }
  }, [hydrateAll])

  if (phase === 'booting') {
    return (
      <div className="app-root" aria-busy="true">
        <div className="boot-splash">
          <div className="boot-mark">⚡</div>
        </div>
      </div>
    )
  }

  if (phase === 'welcome') {
    return <WelcomePage onEnterApp={() => setPhase('app')} />
  }

  return (
    <div className="app-root">
      <Layout />
    </div>
  )
}
