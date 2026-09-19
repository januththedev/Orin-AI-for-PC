import { useEffect, useState } from 'react'
import { Github, MessageSquare, FileText, HardDrive } from 'lucide-react'
import { bridge } from '../../bridge/client'
import './settings.css'

interface ConnectorDef {
  id: string
  name: string
  description: string
  tokenHint: string
  tokenUrl: string
  icon: typeof Github
  needsOAuth?: boolean
}

const CONNECTORS: ConnectorDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Let the agent open, comment, and manage issues and PRs.',
    tokenHint: 'Personal access token (classic) with repo scope',
    tokenUrl: 'https://github.com/settings/tokens',
    icon: Github,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Let the agent post updates and read channels you approve.',
    tokenHint: 'Bot token (xoxb-…) with chat:write',
    tokenUrl: 'https://api.slack.com/apps',
    icon: MessageSquare,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Let the agent search pages and append notes.',
    tokenHint: 'Internal integration secret',
    tokenUrl: 'https://www.notion.so/my-account/integrations',
    icon: FileText,
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    description: 'Attach docs and sheets as project knowledge.',
    tokenHint: '',
    tokenUrl: '',
    icon: HardDrive,
    needsOAuth: true,
  },
]

type Status = 'unknown' | 'connected' | 'missing'

export default function ConnectorsPage() {
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [account, setAccount] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [note, setNote] = useState<Record<string, string>>({})

  useEffect(() => {
    CONNECTORS.filter((c) => !c.needsOAuth).forEach((c) => {
      bridge
        .connectorHasCred(c.id)
        .then((has) => setStatus((prev) => ({ ...prev, [c.id]: has ? 'connected' : 'missing' })))
        .catch(() => setStatus((prev) => ({ ...prev, [c.id]: 'missing' })))
    })
  }, [])

  const markBusy = (id: string, value: boolean) =>
    setBusy((prev) => ({ ...prev, [id]: value }))

  const save = async (c: ConnectorDef) => {
    const token = tokens[c.id]?.trim()
    if (!token) return
    markBusy(c.id, true)
    setNote((prev) => ({ ...prev, [c.id]: '' }))
    try {
      await bridge.connectorSetCred(c.id, token)
      const name = await bridge.connectorTest(c.id)
      setStatus((prev) => ({ ...prev, [c.id]: 'connected' }))
      setAccount((prev) => ({ ...prev, [c.id]: name }))
      setTokens((prev) => ({ ...prev, [c.id]: '' }))
      setNote((prev) => ({ ...prev, [c.id]: `Connected as ${name} ✓` }))
    } catch (error) {
      setNote((prev) => ({ ...prev, [c.id]: String(error) }))
    } finally {
      markBusy(c.id, false)
    }
  }

  const disconnect = async (c: ConnectorDef) => {
    await bridge.connectorRemove(c.id).catch(() => {})
    setStatus((prev) => ({ ...prev, [c.id]: 'missing' }))
    setAccount((prev) => ({ ...prev, [c.id]: '' }))
    setNote((prev) => ({ ...prev, [c.id]: 'Disconnected.' }))
  }

  return (
    <div className="settings-page">
      <h1 className="settings-title">Connections</h1>
      <p className="settings-note" style={{ marginTop: 0 }}>
        Tokens live only in this PC&apos;s OS credential manager and are
        injected server-side on each call — the agent uses your services
        without ever seeing your secrets.
      </p>
      <div className="card-list" style={{ marginTop: 18 }}>
        {CONNECTORS.map((c) => (
          <div className="item-card" key={c.id}>
            <span className="glyph">
              <c.icon size={17} />
            </span>
            <div className="item-copy">
              <strong>{c.name}</strong>
              <span>{c.description}</span>
              {c.needsOAuth ? (
                <span className="setting-hint">OAuth arrives with cloud sync — no token to paste yet.</span>
              ) : status[c.id] === 'connected' ? (
                <span className="setting-hint">
                  Connected{account[c.id] ? ` as ${account[c.id]}` : ''} · token hidden
                </span>
              ) : (
                <span className="setting-hint">
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      void bridge.openExternal(c.tokenUrl)
                    }}
                  >
                    Get a token
                  </a>
                  {' · '}
                  {c.tokenHint}
                </span>
              )}
              {note[c.id] && <span className="setting-hint">{note[c.id]}</span>}
            </div>
            {c.needsOAuth ? (
              <span className="status-pill status-waiting">OAuth soon</span>
            ) : (
              <span
                className={`status-pill ${status[c.id] === 'connected' ? 'status-connected' : 'status-disconnected'}`}
              >
                {status[c.id] === 'connected' ? 'Connected' : 'Not connected'}
              </span>
            )}
          </div>
        ))}
      </div>
      {CONNECTORS.filter((c) => !c.needsOAuth).map((c) => (
        <div className="setting-row" key={`cred-${c.id}`}>
          <div className="setting-copy">
            <span className="setting-label">{c.name} token</span>
            <span className="setting-hint">
              {status[c.id] === 'connected' ? 'Replace anytime — the agent picks it up immediately.' : c.tokenHint}
            </span>
          </div>
          <div className="setting-control">
            <input
              className="text-input"
              type="password"
              placeholder={status[c.id] === 'connected' ? 'Replace token…' : 'Paste token…'}
              value={tokens[c.id] ?? ''}
              onChange={(e) => setTokens((prev) => ({ ...prev, [c.id]: e.target.value }))}
            />
            <button
              className="connect-button"
              disabled={busy[c.id]}
              onClick={() => void save(c)}
            >
              {busy[c.id] ? '…' : 'Save + test'}
            </button>
            {status[c.id] === 'connected' && (
              <button className="connect-button" onClick={() => void disconnect(c)}>
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
