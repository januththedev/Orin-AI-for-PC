import { useEffect, useMemo, useState } from 'react'
import { Loader2, Zap, KeyRound, ArrowLeft } from 'lucide-react'
import { bridge } from '../../bridge/client'
import { useSettingsStore } from '../../stores/settingsStore'
import { OrinMark } from '../../components/OrinMark'
import './welcome.css'

type View = 'choose' | 'browser' | 'byok'

interface ProviderOption {
  id: string
  label: string
  baseUrl: string
  keyRequired: boolean
  hasKey: boolean
}

/**
 * First-run welcome screen — the gate before the workspace. Two ways in:
 * sign in with an existing Orin AI account (browser device flow; account
 * creation lives on orinai.org, never here), or connect your own API key.
 * A quiet "explore offline" escape hatch keeps the app demoable with no keys.
 */
export default function WelcomePage({ onEnterApp }: { onEnterApp: () => void }) {
  const [view, setView] = useState<View>('choose')
  const [error, setError] = useState<string | null>(null)
  const [deviceUserCode, setDeviceUserCode] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const browserSignIn = async () => {
    setError(null)
    setConnecting(true)
    setView('browser')
    try {
      const start = await bridge.authDeviceStart()
      setDeviceUserCode(start.userCode)
      const session = await bridge.authDeviceWait(start.deviceCode)
      if (session?.uid) {
        await dismiss()
        onEnterApp()
        return
      }
      setError('Sign-in did not complete — try again.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setConnecting(false)
    setDeviceUserCode(null)
  }

  const dismiss = async () => {
    try {
      await bridge.storeSet('onboarding.dismissed', 1)
    } catch {
      // persistence is best-effort; entering the app still proceeds
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-stack">
        <div className="welcome-hero">
          <div className="welcome-mark">
            <OrinMark size={56} />
          </div>
          <h1>Welcome to Orin Code</h1>
          <p>Chat, build, and let Orin work on your PC — powered by any model you choose.</p>
        </div>

        {view === 'choose' && (
          <div className="welcome-options">
            <button className="welcome-option primary" disabled={connecting} onClick={() => void browserSignIn()}>
              <Zap size={18} />
              <span>
                <strong>Sign in with Orin AI</strong>
                <small>Opens orinai.org in your browser — one click to approve</small>
              </span>
            </button>
            <button className="welcome-option" onClick={() => setView('byok')}>
              <KeyRound size={18} />
              <span>
                <strong>Connect your own API key</strong>
                <small>Anthropic, OpenRouter, Groq, Ollama… stored safely on this PC</small>
              </span>
            </button>
            <p className="welcome-gate-note">Sign in or connect a key to enter — there is no offline mode.</p>
          </div>
        )}

        {view === 'browser' && (
          <div className="welcome-browser">
            {connecting ? (
              <>
                <Loader2 className="welcome-spin" size={22} />
                {deviceUserCode ? (
                  <>
                    <p className="welcome-copy">Approve this code in your browser:</p>
                    <div className="welcome-code">{deviceUserCode}</div>
                    <p className="welcome-copy dim">
                      This window connects automatically once you approve.
                    </p>
                  </>
                ) : (
                  <p className="welcome-copy">Opening orinai.org…</p>
                )}
              </>
            ) : (
              <p className="welcome-copy">{error ?? 'Something went wrong.'}</p>
            )}
            {error && <p className="account-error">{error}</p>}
            <button
              className="welcome-back"
              onClick={() => {
                setView('choose')
                setError(null)
                setDeviceUserCode(null)
              }}
            >
              Back
            </button>
          </div>
        )}

        {view === 'byok' && (
          <ByoKeyForm
            onBack={() => setView('choose')}
            onConnected={() => void dismiss().then(onEnterApp)}
          />
        )}

        <p className="welcome-footnote">
          New to Orin? Accounts are created on{' '}
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault()
              void bridge.openExternal('https://www.orinai.org')
            }}
          >
            orinai.org
          </a>{' '}
          — then sign in here.
        </p>
      </div>
    </div>
  )
}

function ByoKeyForm({ onBack, onConnected }: { onBack: () => void; onConnected: () => void }) {
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [providerId, setProviderId] = useState('')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const updateSettings = useSettingsStore.getState().update

  useEffect(() => {
    bridge
      .providersList()
      .then((list) => {
        const withKeys = list.filter((provider) => provider.keyRequired)
        setProviders(withKeys)
        if (withKeys.length > 0) setProviderId(withKeys[0].id)
      })
      .catch(() => setError('Could not load providers — try again in a moment.'))
  }, [])

  const selected = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providers, providerId],
  )

  const connect = async () => {
    if (!selected || !key.trim()) return
    setSaving(true)
    setError(null)
    try {
      await bridge.providerSetKey(selected.id, key.trim())
      // Best-effort: point the composer at a real model from this gateway.
      try {
        const models = await bridge.modelsFetch(selected.id)
        const current = useSettingsStore.getState().defaultModelId
        if (models.length > 0 && current.startsWith('mock/')) {
          updateSettings({ defaultModelId: models[0].id })
        }
      } catch {
        // Model listing is optional; the key is saved either way.
      }
      onConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="welcome-byok">
      <label className="welcome-label">
        Provider
        <select
          className="select-input"
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
              {provider.hasKey ? ' · connected' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="welcome-label">
        API key
        <input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={`Paste your ${selected?.label ?? ''} key…`}
        />
      </label>
      <p className="welcome-copy dim">
        Stored in Windows Credential Manager, used only by Orin's local core.
      </p>
      {error && <p className="account-error">{error}</p>}
      <button className="btn btn-primary" disabled={saving || !key.trim()} onClick={() => void connect()}>
        {saving ? 'Connecting…' : 'Save & continue'}
      </button>
      <button className="welcome-back" onClick={onBack}>
        <ArrowLeft size={13} /> Back
      </button>
    </div>
  )
}
