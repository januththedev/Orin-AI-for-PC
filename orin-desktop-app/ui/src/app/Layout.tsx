import { lazy, Suspense, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  PanelLeftClose,
  PanelLeftOpen,
  Minus,
  Square,
  X,
  Home,
  Plus,
  FolderClosed,
  Shapes,
  SlidersHorizontal,
  Monitor,
  Sparkles,
} from 'lucide-react'
import { bridge } from '../bridge/client'
import { OrinMark } from '../components/OrinMark'
import { Palette, useAppCommands } from '../components/CommandPalette'
import { useUiStore, type ViewId } from '../stores/uiStore'
import { useChatsStore } from '../stores/chatsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAuthStore } from '../stores/authStore'
import { SETTINGS_SECTION_KEY } from '../features/settings/SettingsPage'
import { HistorySearch } from '../features/chat/HistorySearch'
import { CurrentView, ViewFallback } from './routes'

function TitleBar() {
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const collapsed = useUiStore((state) => state.sidebarCollapsed)

  const windowControls = bridge.isTauri ? (
    <div className="titlebar-controls">
      <button
        className="titlebar-button"
        aria-label="Minimize"
        onClick={() => getCurrentWindow().minimize()}
      >
        <Minus size={14} />
      </button>
      <button
        className="titlebar-button"
        aria-label="Maximize"
        onClick={() => getCurrentWindow().toggleMaximize()}
      >
        <Square size={11} />
      </button>
      <button
        className="titlebar-button titlebar-close"
        aria-label="Close"
        onClick={() => getCurrentWindow().close()}
      >
        <X size={15} />
      </button>
    </div>
  ) : null

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left">
        <button
          className="icon-ghost"
          aria-label="Toggle sidebar"
          onClick={toggleSidebar}
          title="Toggle sidebar (Ctrl+B)"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>
      <div className="titlebar-center" data-tauri-drag-region>
        <OrinMark size={18} />
        <span className="titlebar-name">Orin Code</span>
      </div>
      <div className="titlebar-right">{windowControls}</div>
    </header>
  )
}

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: typeof Home }> = [
  { id: 'projects', label: 'Projects', icon: FolderClosed },
  { id: 'artifacts', label: 'Artifacts', icon: Shapes },
  { id: 'studio', label: 'Studio', icon: Sparkles },
  { id: 'computer', label: 'Computer Use', icon: Monitor },
  { id: 'customize', label: 'Customize', icon: SlidersHorizontal },
]

function NavRail() {
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const conversations = useChatsStore((state) => state.conversations)
  const activeId = useChatsStore((state) => state.activeId)
  const selectChat = useChatsStore((state) => state.selectChat)
  const createChat = useChatsStore((state) => state.createChat)
  const authStatus = useAuthStore((state) => state.status)

  useEffect(() => {
    void useAuthStore.getState().hydrate()
  }, [])

  const session = authStatus?.signedIn ? authStatus.session : null
  const accountLabel = session ? `${session.name} · Cloud plan` : 'You · Local mode'
  const openAccount = () => {
    localStorage.setItem(SETTINGS_SECTION_KEY, 'account')
    setView('settings')
  }

  const recents = conversations.filter((chat) => !chat.archived).slice(0, 24)

  const goHome = () => setView('home')

  if (collapsed) {
    return (
      <nav className="navrail navrail-collapsed">
        <button className="rail-icon active-home" title="Home" onClick={goHome}>
          <OrinMark size={22} />
        </button>
        <button
          className="rail-icon"
          title="New conversation (Ctrl+N)"
          onClick={() => {
            createChat()
            setView('chat')
          }}
        >
          <Plus size={17} />
        </button>
        {NAV_ITEMS.map((item) => (
          <button key={item.id} className={`rail-icon ${view === item.id ? 'active' : ''}`} title={item.label} onClick={() => setView(item.id)}>
            <item.icon size={17} />
          </button>
        ))}
      </nav>
    )
  }

  return (
    <nav className="navrail">
      <div className="rail-tabs">
        <button className={`rail-tab ${view === 'home' || view === 'chat' ? 'active' : ''}`} onClick={goHome}>
          <Home size={14} /> Home
        </button>
        <button className={`rail-tab ${view === 'ide' ? 'active' : ''}`} onClick={() => setView('ide')}>
          {'</>'} Code
        </button>
      </div>

      <button
        className="new-chat-button"
        onClick={() => {
          createChat()
          setView('chat')
        }}
      >
        <Plus size={15} /> New
      </button>

      <div className="rail-items">
        {NAV_ITEMS.map((item) => (
          <button key={item.id} className={`rail-item ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}>
            <item.icon size={15} /> {item.label}
          </button>
        ))}
      </div>

      <div className="rail-section">
        <span className="rail-heading">Chats and tasks</span>
        <div className="rail-recents">
          {recents.length === 0 && <p className="rail-empty">No conversations yet</p>}
          {recents.map((chat) => (
            <button
              key={chat.id}
              className={`recent-chat ${chat.id === activeId ? 'active' : ''}`}
              onClick={() => {
                selectChat(chat.id)
                setView('chat')
              }}
              title={chat.title}
            >
              <span className="recent-dot" />
              {chat.pinned ? '★ ' : ''}
              {chat.title}
            </button>
          ))}
        </div>
      </div>

      <footer className="rail-footer">
        <button className="account-chip" onClick={openAccount} title={session ? 'Account settings' : 'Sign in'}>
          <span className="account-avatar">{(session?.name?.[0] ?? 'Y').toUpperCase()}</span>
          {accountLabel}
        </button>
        <button className="rail-footer-icon" title="Settings" onClick={() => setView('settings')}>
          <SlidersHorizontal size={14} />
        </button>
      </footer>
    </nav>
  )
}

function ToastHost() {
  const toasts = useUiStore((state) => state.toasts)
  const dismiss = useUiStore((state) => state.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <button key={toast.id} className={`toast toast-${toast.level}`} onClick={() => dismiss(toast.id)}>
          <strong>{toast.title}</strong>
          {toast.body && <span>{toast.body}</span>}
        </button>
      ))}
    </div>
  )
}

export default function Layout() {
  const view = useUiStore((state) => state.view)
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const setView = useUiStore((state) => state.setView)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const createChat = useChatsStore((state) => state.createChat)
  const searchOpen = useUiStore((state) => state.searchOpen)
  const setSearchOpen = useUiStore((state) => state.setSearchOpen)
  const paletteOpen = useUiStore((state) => state.paletteOpen)
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return
      if (event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebar()
      }
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault()
        createChat()
        setView('chat')
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(!useUiStore.getState().searchOpen)
      }
      if (event.key.toLowerCase() === 'p' && event.shiftKey) {
        event.preventDefault()
        setPaletteOpen(!useUiStore.getState().paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, createChat, setView, setSearchOpen, setPaletteOpen])

  const commands = useAppCommands({
    newChat: () => {
      createChat()
      setView('chat')
    },
    navigate: (next) => setView(next),
    toggleTheme: () => {
      const settings = useSettingsStore.getState()
      settings.update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
    },
    openSearch: () => setSearchOpen(true),
  })

  // The IDE and Computer Use views own the whole main region (no padding).
  const fullBleed = view === 'ide' || view === 'computer'

  return (
    <div className="shell">
      <TitleBar />
      <div className="shell-body">
        <NavRail />
        <main className={`main-view ${fullBleed ? 'full-bleed' : ''}`}>
          <Suspense fallback={<ViewFallback />}>
            <CurrentView view={view} />
          </Suspense>
        </main>
      </div>
      <ToastHost />
      <HistorySearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  )
}
