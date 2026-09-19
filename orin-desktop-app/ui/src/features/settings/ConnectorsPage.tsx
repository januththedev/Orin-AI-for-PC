import { useEffect, useState } from 'react'
import { Github, MessageSquare, FileText, HardDrive, Plug } from 'lucide-react'
import { bridge } from '../../bridge/client'
import type { McpServer } from '../../bridge/types'
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
      <McpSection />
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

function McpSection() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [toolCounts, setToolCounts] = useState<Record<string, string>>({})

  const refresh = async () => {
    try {
      setServers(await bridge.mcpServers())
    } catch {
      setServers([])
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const add = async () => {
    if (!name.trim() || !url.trim()) {
      setNote('Give the server a name and URL first.')
      return
    }
    setBusy(true)
    setNote('')
    try {
      const id = await bridge.mcpAddServer(name.trim(), url.trim())
      if (key.trim()) await bridge.mcpSetKey(id, key.trim())
      const summary = await bridge.mcpTest(id)
      setToolCounts((prev) => ({ ...prev, [id]: summary }))
      setName('')
      setUrl('')
      setKey('')
      setNote(`Connected — ${summary} ✓`)
      await refresh()
    } catch (error) {
      setNote(String(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    await bridge.mcpRemoveServer(id).catch(() => {})
    await refresh()
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="setting-row">
        <div className="setting-copy">
          <span className="setting-label">
            <Plug size={13} style={{ verticalAlign: -2 }} /> MCP servers
          </span>
          <span className="setting-hint">
            Gmail, Drive, OneDrive and friends via any Streamable-HTTP MCP server — e.g. your hosted
            provider&apos;s endpoint. No Google Cloud / Azure app setup: the provider owns OAuth, you
            paste a URL + key. The agent discovers tools itself.
          </span>
        </div>
      </div>
      {servers.map((s) => (
        <div className="setting-row" key={s.id}>
          <div className="setting-copy">
            <span className="setting-label">{s.name}</span>
            <span className="setting-hint">
              {s.url} · {s.hasKey ? 'key stored' : 'no key'} · {toolCounts[s.id] ?? 'untested'}
            </span>
          </div>
          <div className="setting-control">
            <button className="connect-button" onClick={() => void remove(s.id)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="setting-row">
        <div className="setting-copy">
          <span className="setting-label">Add server</span>
          <span className="setting-hint">{note || 'Name it (e.g. Gmail), paste the MCP endpoint URL and key.'}</span>
        </div>
        <div className="setting-control" style={{ flexWrap: 'wrap', gap: 6 }}>
          <input
            className="text-input"
            placeholder="Name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="text-input"
            placeholder="https://…/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            className="text-input"
            type="password"
            placeholder="Key (optional)…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="connect-button" disabled={busy} onClick={() => void add()}>
            {busy ? '…' : 'Save + test'}
          </button>
        </div>
      </div>
    </div>
  )
}
