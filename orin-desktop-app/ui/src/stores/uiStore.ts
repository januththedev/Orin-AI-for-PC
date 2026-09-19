import { create } from 'zustand'
import { bridge } from '../bridge/client'
import type { NotifyLevel } from '../bridge/types'

export type ViewId =
  | 'home'
  | 'chat'
  | 'projects'
  | 'artifacts'
  | 'studio'
  | 'customize'
  | 'settings'
  | 'skills'
  | 'connectors'
  | 'ide'
  | 'computer'

export interface Toast {
  id: string
  level: NotifyLevel
  title: string
  body?: string
}

interface UiState {
  view: ViewId
  sidebarCollapsed: boolean
  searchOpen: boolean
  paletteOpen: boolean
  toasts: Toast[]
  setView: (view: ViewId) => void
  toggleSidebar: () => void
  setSearchOpen: (open: boolean) => void
  setPaletteOpen: (open: boolean) => void
  toast: (level: NotifyLevel, title: string, body?: string) => void
  dismissToast: (id: string) => void
  hydrateAll: () => Promise<void>
}

const UI_KEY = 'ui'

interface PersistedUi {
  view?: ViewId
  sidebarCollapsed?: boolean
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'home',
  sidebarCollapsed: false,
  searchOpen: false,
  paletteOpen: false,
  toasts: [],

  setView: (view) => set({ view }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  toast: (level, title, body) => {
    const id = crypto.randomUUID()
    set((state) => ({ toasts: [...state.toasts, { id, level, title, body }] }))
    setTimeout(() => get().dismissToast(id), 4200)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  hydrateAll: async () => {
    try {
      const saved = await bridge.storeGet<PersistedUi>(UI_KEY)
      if (saved && typeof saved === 'object') {
        set({
          view: saved.view ?? 'home',
          sidebarCollapsed: saved.sidebarCollapsed ?? false,
        })
      }
    } catch {
      // First launch or storage unavailable — defaults are fine.
    }
    // Sibling slices own their own hydration.
    const chatsModule = await import('./chatsStore')
    await chatsModule.useChatsStore.getState().hydrate()
    const settingsModule = await import('./settingsStore')
    await settingsModule.useSettingsStore.getState().hydrate()
    const artifactsModule = await import('./artifactsStore')
    await artifactsModule.useArtifactsStore.getState().hydrate()
    const projectsModule = await import('./projectsStore')
    await projectsModule.useProjectsStore.getState().hydrate()
  },
}))

let saveTimer: ReturnType<typeof setTimeout> | undefined
export function persistUi() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const { view, sidebarCollapsed } = useUiStore.getState()
    bridge.storeSet(UI_KEY, { view, sidebarCollapsed }).catch(() => {})
  }, 350)
}

// Re-save whenever layout-relevant fields change.
useUiStore.subscribe((state, prev) => {
  if (state.view !== prev.view || state.sidebarCollapsed !== prev.sidebarCollapsed) persistUi()
})
