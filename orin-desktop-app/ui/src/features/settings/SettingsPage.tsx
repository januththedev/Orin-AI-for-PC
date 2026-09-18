import { useEffect, useState } from 'react'
import { bridge } from '../../bridge/client'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAuthStore } from '../../stores/authStore'
import { SettingRow, SettingsLayout, useLocalSection, Toggle } from './SettingsLayout'
import './settings.css'

/** Storage key shared with Layout's account chip, which deep-links here. */
export const SETTINGS_SECTION_KEY = 'settings-active-section'

function ModelsSection() {
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({})
  const [savedProvider, setSavedProvider] = useState<string | null>(null)
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({})
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({})
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [providers, setProviders] = useState<Array<{ id: string; label: string; docsUrl: string; keyRequired: boolean }>>([
    { id: 'anthropic', label: 'Anthropic', docsUrl: 'https://console.anthropic.com/settings/keys', keyRequired: true },
    { id: 'openai', label: 'OpenAI', docsUrl: 'https://platform.openai.com/api-keys', keyRequired: true },
  ])

  useEffect(() => {
    bridge
      .providersList()
      .then((list) => {
        if (list.length > 0) setProviders(list.map((p) => ({ id: p.id, label: p.label, docsUrl: p.docsUrl, keyRequired: p.keyRequired })))
      })
      .catch(() => {})
      .finally(() => {
        providers.forEach((provider) => {
          bridge
            .providerHasKey(provider.id)
            .then((present) => setHasKey((prev) => ({ ...prev, [provider.id]: present })))
            .catch(() => setHasKey((prev) => ({ ...prev, [provider.id]: false })))
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    providers.forEach((provider) => {
      if (!(provider.id in hasKey)) {
        bridge
          .providerHasKey(provider.id)
          .then((present) => setHasKey((prev) => ({ ...prev, [provider.id]: present })))
          .catch(() => setHasKey((prev) => ({ ...prev, [provider.id]: false })))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])

  const save = async (providerId: string) => {
    const key = keys[providerId]?.trim()
    if (!key) return
    try {
      await bridge.providerSetKey(providerId, key)
      setHasKey((prev) => ({ ...prev, [providerId]: true }))
      setSavedProvider(providerId)
      setKeys((prev) => ({ ...prev, [providerId]: '' }))
      setTimeout(() => setSavedProvider(null), 2500)
    } catch (error) {
      setKeys((prev) => ({ ...prev, [providerId]: String(error) }))
    }
  }

  const refreshModels = async (providerId: string) => {
    setRefreshing((prev) => ({ ...prev, [providerId]: true }))
    setModelErrors((prev) => ({ ...prev, [providerId]: '' }))
    try {
      const models = await bridge.modelsFetch(providerId)
      setModelCounts((prev) => ({ ...prev, [providerId]: models.length }))
      if (models.length === 0) setModelErrors((prev) => ({ ...prev, [providerId]: 'No models returned.' }))
    } catch (error) {
      setModelErrors((prev) => ({ ...prev, [providerId]: String(error) }))
    } finally {
      setRefreshing((prev) => ({ ...prev, [providerId]: false }))
    }
  }

  return (
    <div>
      <SettingRow label="Default model" hint="Used for new conversations — pick it from the composer’s model menu.">
        <span className="setting-hint">Per-conversation override available</span>
      </SettingRow>
      {providers.map((provider) => (
        <div className="setting-row" key={provider.id}>
          <div className="setting-copy">
            <span className="setting-label">{provider.label}</span>
            <span className="setting-hint">
              {hasKey[provider.id] ? 'Key stored in OS credential manager · ' : provider.keyRequired ? 'No key yet · ' : 'Local — no key needed · '}
              {provider.docsUrl ? (
                <a href="#" onClick={(e) => { e.preventDefault(); void bridge.openExternal(provider.docsUrl) }}>
                  Get key
                </a>
              ) : (
                <span>Custom endpoint</span>
              )}
              {provider.id in modelCounts ? ` · ${modelCounts[provider.id]} models` : ''}
              {savedProvider === provider.id ? ' · Saved ✓' : ''}
              {modelErrors[provider.id] ? ` · ${modelErrors[provider.id]}` : ''}
            </span>
          </div>
          <div className="setting-control">
            <input
              className="text-input"
              type="password"
              placeholder={hasKey[provider.id] ? 'Replace key…' : provider.keyRequired ? 'Paste API key…' : 'Optional key…'}
              value={keys[provider.id] ?? ''}
              onChange={(event) => setKeys((prev) => ({ ...prev, [provider.id]: event.target.value }))}
            />
            <button className="connect-button" onClick={() => save(provider.id)}>
              Save
            </button>
            <button className="connect-button" onClick={() => refreshModels(provider.id)} disabled={refreshing[provider.id]}>
              {refreshing[provider.id] ? '…' : 'Models'}
            </button>
          </div>
        </div>
      ))}
      <p className="settings-note">
        Paste a key and hit Models — the live catalog loads automatically with built-in
        endpoints and headers. Keys live in the OS credential manager and are used only
        by the local Rust core — never in project files or history.
      </p>
    </div>
  )
}

function SignInForm({
  busy,
  deviceUserCode,
}: {
  busy: boolean
  deviceUserCode: string | null
}) {
  const [mode, setMode] = useState<'browser' | 'password'>('browser')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const browserLogin = async () => {
    setError(null)
    const err = await useAuthStore.getState().loginWithBrowser()
    if (err) setError(err)
  }

  // Accounts are created on orinai.org only — the desktop app signs in,
  // it never registers.
  const submit = async () => {
    setError(null)
    const err = await useAuthStore.getState().login(identifier.trim(), password)
    if (err) setError(err)
  }

  const waiting = busy && mode === 'browser'

  return (
    <div className="account-auth">
      <div className="account-tabs">
        <button className={mode === 'browser' ? 'active' : ''} onClick={() => setMode('browser')}>
          Browser sign-in
        </button>
        <button className={mode === 'password' ? 'active' : ''} onClick={() => setMode('password')}>
          Email / phone
        </button>
      </div>

      {mode === 'browser' ? (
        <>
          <button className="btn btn-primary" disabled={busy} onClick={() => void browserLogin()}>
            {waiting ? 'Waiting for approval…' : 'Sign in via orinai.org'}
          </button>
          {waiting ? (
            <p className="setting-hint">
              Your browser opened the Orin AI sign-in page. Sign in there and approve code{' '}
              <span className="account-code">{deviceUserCode}</span> — this app connects automatically.
            </p>
          ) : (
            <p className="setting-hint">
              Opens www.orinai.org in your browser. Sign in there and approve this device.
            </p>
          )}
        </>
      ) : (
        <>
          <label>
            Email or phone
            <input
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="you@example.com or +94…"
            />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p className="account-error">{error}</p>}
          <button
            className="btn btn-primary"
            disabled={busy || !identifier.trim() || !password}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : 'Sign in'}
          </button>
        </>
      )}

      {error && mode === 'browser' && <p className="account-error">{error}</p>}
      <p className="setting-hint">Same account as orinai.org. Your password is verified server-side only.</p>
    </div>
  )
}

function AccountSection() {
  const status = useAuthStore((state) => state.status)
  const busy = useAuthStore((state) => state.busy)
  const deviceUserCode = useAuthStore((state) => state.deviceUserCode)
  const logout = useAuthStore((state) => state.logout)
  const [view, setView] = useState<'signin' | 'byok'>('signin')

  useEffect(() => {
    useAuthStore.getState().hydrate()
  }, [])

  if (status?.signedIn && status.session) {
    const who = status.session.email || status.session.phone
    return (
      <div>
        <SettingRow label="Signed in as" hint={`Orin AI account · ${status.session.name}`}>
          <span className="status-pill status-connected">{who}</span>
        </SettingRow>
        <SettingRow label="Plan" hint="Cloud models are metered by your orinai.org plan.">
          <span className="status-pill status-connected">Linked</span>
        </SettingRow>
        <SettingRow label="Sync across devices" hint="Settings and chats follow your Orin AI account.">
          <Toggle
            checked={useSettingsStore.getState().cloudSync}
            onChange={(value) => useSettingsStore.getState().update({ cloudSync: value })}
          />
        </SettingRow>
        <div className="account-actions">
          <button className="connect-button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (view === 'byok') {
    return (
      <div>
        <ModelsSection />
        <div className="account-actions">
          <button className="connect-button" onClick={() => setView('signin')}>
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <SignInForm busy={busy} deviceUserCode={deviceUserCode} />
      <div className="account-actions">
        <button className="account-link" onClick={() => setView('byok')}>
          Use your own API key instead
        </button>
      </div>
    </div>
  )
}

const SHORTCUTS: Array<[string, string]> = [
  ['New conversation', 'Ctrl + N'],
  ['Toggle sidebar', 'Ctrl + B'],
  ['Send message', 'Enter'],
  ['Newline in composer', 'Shift + Enter'],
]

export default function SettingsPage() {
  const settings = useSettingsStore()
  const [sectionId, selectSection] = useLocalSection('general', SETTINGS_SECTION_KEY)

  const sections = [
    {
      id: 'general',
      label: 'General',
      content: (
        <div>
          <SettingRow label="Default mode" hint="Mode pre-selected on new conversations.">
            <select
              className="select-input"
              value={settings.defaultMode}
              onChange={(event) =>
                settings.update({ defaultMode: event.target.value as typeof settings.defaultMode })
              }
            >
              <option value="chat">Chat</option>
              <option value="cowork">Cowork</option>
              <option value="agent">Agent</option>
              <option value="computer">Computer Use</option>
            </select>
          </SettingRow>
          <SettingRow label="Version" hint="Orin AI desktop — local-first build.">
            <span className="setting-hint">0.1.0</span>
          </SettingRow>
        </div>
      ),
    },
    {
      id: 'models',
      label: 'Models',
      content: <ModelsSection />,
    },
    {
      id: 'behavior',
      label: 'AI behavior',
      content: (
        <div>
          <SettingRow label="Response style" hint="Concise answers by default; detailed when asked.">
            <span className="setting-hint">Per-project instructions land with Projects.</span>
          </SettingRow>
          <SettingRow label="Tool permissions" hint="File writes and commands always ask before running.">
            <span className="setting-hint">Approved per session from the AI panel.</span>
          </SettingRow>
        </div>
      ),
    },
    {
      id: 'privacy',
      label: 'Privacy',
      content: (
        <div>
          <SettingRow label="Local-first storage" hint="Conversations, projects, and artifacts live in a local SQLite database.">
            <span className="status-pill status-connected">On</span>
          </SettingRow>
          <SettingRow label="Telemetry" hint="None. Nothing leaves this machine except model API calls you send.">
            <span className="status-pill status-connected">Off</span>
          </SettingRow>
        </div>
      ),
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      content: (
        <table className="shortcut-table">
          <tbody>
            {SHORTCUTS.map(([label, combo]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{combo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    },
    {
      id: 'account',
      label: 'Account',
      content: <AccountSection />,
    },
  ]

  return (
    <SettingsLayout title="Settings" sections={sections} activeId={sectionId} onSelect={selectSection} />
  )
}
