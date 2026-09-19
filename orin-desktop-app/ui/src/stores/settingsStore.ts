import { create } from 'zustand'
import { bridge } from '../bridge/client'

export type Density = 'comfortable' | 'compact'

interface SettingsState {
  theme: 'dark' | 'light'
  accent: string
  density: Density
  fontSize: number
  codeFont: string
  defaultModelId: string
  defaultMode: 'chat' | 'cowork' | 'agent' | 'computer'
  cloudSync: boolean
  /** Run phone-confirmed Telegram tasks on this PC (explicit opt-in). */
  phoneTasks: boolean
  hydrate: () => Promise<void>
  update: (patch: Partial<Omit<SettingsState, 'hydrate' | 'update'>>) => void
}

const SETTINGS_KEY = 'settings'

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: 'dark',
  accent: '#e08a3c',
  density: 'comfortable',
  fontSize: 13,
  codeFont: 'JetBrains Mono',
  defaultModelId: 'mock/orin-offline',
  defaultMode: 'chat',
  cloudSync: true,
  phoneTasks: false,

  hydrate: async () => {
    try {
      const saved = await bridge.storeGet<Partial<SettingsState>>(SETTINGS_KEY)
      if (saved && typeof saved === 'object') set(saved)
    } catch {
      // defaults
    }
    // Signed in? Converge with the user's cloud snapshot (remote wins v1).
    try {
      const { pullAndMerge } = await import('./cloudSync')
      await pullAndMerge()
    } catch {
      // offline / signed out — local values stand
    }
    document.documentElement.dataset.theme = get().theme
    document.documentElement.style.setProperty('--accent', get().accent)
  },

  update: (patch) => {
    set(patch)
    const { theme, accent, density, fontSize, codeFont, defaultModelId, defaultMode } = get()
    document.documentElement.dataset.theme = theme
    document.documentElement.style.setProperty('--accent', accent)
    bridge
      .storeSet(SETTINGS_KEY, { theme, accent, density, fontSize, codeFont, defaultModelId, defaultMode })
      .catch(() => {})
    void import('./cloudSync').then(({ scheduleCloudSync }) => scheduleCloudSync())
  },
}))
