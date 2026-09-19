# Orin AI — Bridge Contract (v1)

Single source of truth for the boundary between the Rust core (`src-tauri/`)
and the React UI (`ui/`). Both sides MUST match these names exactly — the
compiler enforces the Rust side (`tauri::generate_handler!` in `lib.rs`),
and `ui/src/bridge/client.ts` enforces the TypeScript side.

Renderer never touches IO itself: every network call, file operation,
process spawn, capture, and injection happens in Rust workers. The renderer
sends commands and listens to events.

## Commands (renderer → core, via `invoke`)

### Persistence (SQLite-backed KV; typed tables may replace later)
| Command | Args | Returns |
|---|---|---|
| `store_get` | `key: string` | `value: JsonValue \| null` |
| `store_set` | `key: string, value: JsonValue` | `null` |
| `store_delete` | `key: string` | `null` |

### AI providers
| Command | Args | Returns |
|---|---|---|
| `ai_send` | `req: AiSendRequest` | `requestId: string` |
| `ai_abort` | `requestId: string` | `null` |
| `models_list` | — | `ModelInfo[]` (built-in catalog + Orin Cloud when signed in) |
| `providers_list` | — | `ProviderInfo[]` (id, label, baseUrl, keyRequired, docsUrl, hasKey) |
| `models_fetch` | `preset_id: string` | `ModelInfo[]` (live per-provider catalog; curated for Anthropic) |
| `provider_set_key` | `provider: string, key: string` | `null` (stores in OS credential manager) |
| `provider_has_key` | `provider: string` | `bool` |

Streaming results arrive as events (see below), correlated by `requestId`.

### Files / workspace
| Command | Args | Returns |
|---|---|---|
| `dialog_pick_folder` | — | `{ name, path } \| null` |
| `fs_read_dir` | `path: string, depth: u32 (max 4)` | `FileNode[]` |
| `fs_read_file` | `path: string` | `content: string` |
| `fs_write_file` | `path: string, content: string` | `null` |
| `fs_exists` | `path: string` | `bool` |
| `git_status` | `root: string` | `map<path, "M"\|"A"\|"D"\|"U"\|"?"\|"clean">` |
| `search_workspace` | `root: string, query: string, maxResults: u32` | `SearchHit[]` |

### Terminal (ConPTY)
| Command | Args | Returns |
|---|---|---|
| `term_create` | `cwd: string \| null` | `terminalId: string` |
| `term_write` | `terminalId: string, data: string` | `null` |
| `term_resize` | `terminalId: string, cols: u16, rows: u16` | `null` |
| `term_kill` | `terminalId: string` | `null` |

### Agent loop (server-side tool-use cycle)
| Command | Args | Returns |
|---|---|---|
| `agent_run` | `task: AgentTask` | `runId: string` |
| `agent_stop` | `runId: string` | `null` |
| `approval_respond` | `approvalId: string, approved: bool` | `null` |

The loop emits `agent-event` stream items. When a tool needs permission the
core emits an `approval-request` inside `agent-event` and blocks until
`approval_respond`.

### Computer Use
| Command | Args | Returns |
|---|---|---|
| `cu_start` | `task: CuTask` | `sessionId: string` |
| `cu_stop` | `sessionId: string` | `null` |
| `cu_permission_respond` | `promptId: string, allowed: bool` | `null` |
| `cu_available_providers` | — | `["virtual", "windows", ...]` (present ones) |

### Account (orinai.org sign-in)
| Command | Args | Returns |
|---|---|---|
| `auth_login` | `identifier: string, password: string` | `Session` |
| `auth_register` | `name: string, identifier: string, password: string` | `Session` |
| `auth_device_start` | — | `{ deviceCode, userCode, verifyUrl, expiresInSecs }` — also opens the system browser at `verifyUrl` |
| `auth_device_wait` | `deviceCode: string` | `Session` once approved; errors on denied/expired/timeout |
| `auth_status` | — | `{ signedIn: bool, session: Session \| null }` |
| `auth_logout` | — | `null` |
| `open_external` | `url: string` (http/https only) | opens the system browser — used for account creation, which lives on orinai.org |

Session = `{uid, name, email, phone, authKind: "firebase" | "clerk"}`.
Password sign-in calls `/api/auth/password`; browser sign-in uses the device
grant on `/api/auth/device` (start → user approves the shown code on
orinai.org → poll returns the approval). A Clerk approval —
`{ auth_kind: "clerk", session_token, refresh_token?, user }` — is stored
directly and refreshed via `POST /api/auth/clerk/refresh`; a legacy approval
carries a Firebase custom token, exchanged via Identity Toolkit with the
profile read from the ID-token claims. Either way the refresh credential lives
in the OS keyring and the live token (~1 h) never leaves the Rust process.
See `docs/CLERK-BRIDGE.md` for the server contract.
Signed-out is a normal state: cloud features degrade to local mode, and the
Orin Cloud models (`orin/orin-pro`, `orin/orin-flash`) only appear in
`models_list` while a session exists.

### Sync
| Command | Args | Returns |
|---|---|---|
| `sync_pull` | — | `{ blob: object \| null, updatedAt: string \| null }` |
| `sync_push` | `blob: object (≤512 KB), schemaVersion?: number` | `null` |

Backend endpoint: `/api/desktop-sync` (per-user, last-write-wins). The UI
pushes a debounced whole snapshot (`settings` + `chats`) and pulls on launch;
the toggle lives in Settings ▸ Account.

### Misc
| Command | Args | Returns |
|---|---|---|
| `app_info` | — | `{ version, os }` |
| `telegram_set_token` | `token: string` | `null` (OS keyring; token never logged) |
| `telegram_has_token` | — | `bool` |
| `telegram_notify` | `chatId: string, text: string` | `null` |

### Connections (external services for the agent)
| Command | Args | Returns |
|---|---|---|
| `connector_set_cred` | `id: string, token: string` | `null` (OS keyring slot `connector/{id}`) |
| `connector_has_cred` | `id: string` | `bool` |
| `connector_test` | `id: string` | account display name (live probe) |
| `connector_remove` | `id: string` | `null` |

Services: `github`, `slack`, `notion` (Google Drive needs OAuth — inert
until cloud sync). The agent's `service_request` tool calls these with the
token injected server-side; credentials never reach the model.

### MCP servers (Gmail / Drive / OneDrive via hosted MCP, no OAuth setup)
| Command | Args | Returns |
|---|---|---|
| `mcp_servers` | — | `[{ id, name, url, hasKey }]` |
| `mcp_add_server` | `name: string, url: string` | `id` (URL must be http/https) |
| `mcp_remove_server` | `id: string` | `null` (also drops the key) |
| `mcp_set_key` | `id: string, key: string` | `null` (OS keyring, never logged) |
| `mcp_test` | `id: string` | `"Name · N tools"` (handshake + tools/list) |

The agent's `mcp_list_tools` (free) discovers capabilities and `mcp_call`
(approval-gated) invokes them. Protocol: Streamable HTTP JSON-RPC with
`2025-03-26` → `2024-11-05` fallback, SSE replies accepted, stateless v1.

## Events (core → renderer, via `listen`)

| Event | Payload |
|---|---|
| `ai-chunk` | `{ requestId, delta }` |
| `ai-done` | `{ requestId, message: AssistantResult, usage }` |
| `ai-error` | `{ requestId, error }` |
| `term-data` | `{ terminalId, data }` |
| `term-exit` | `{ terminalId, exitCode }` |
| `agent-event` | `{ runId, event: AgentEvent }` |
| `cu-status` | `{ sessionId, phase, detail }` |
| `cu-frame` | `{ sessionId, jpegBase64, width, height }` |
| `cu-action` | `{ sessionId, action: CuAction, result }` |
| `cu-permission` | `{ sessionId, promptId, title, detail, destructive }` |
| `cu-done` | `{ sessionId, summary }` |
| `cu-error` | `{ sessionId, error }` |
| `notify` | `{ level: "info"\|"success"\|"warn"\|"error", title, body? }` |

## Shared types

```ts
type Role = 'user' | 'assistant' | 'system'
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string }

interface AiMessage { role: Role; parts: MessagePart[] }

interface AiSendRequest {
  requestId: string            // generated by renderer (crypto.randomUUID())
  modelId: string              // from models_list()
  system?: string
  messages: AiMessage[]
  maxTokens?: number
}

interface AssistantResult {
  text: string
  toolName?: string            // set when the model requested a tool
  toolInput?: unknown
  stopReason: 'end' | 'tool' | 'aborted' | 'error'
}

interface ModelInfo {
  id: string                   // stable id, e.g. "anthropic/claude-sonnet-4"
  provider: 'anthropic' | 'openai_compat' | 'mock'
  label: string                // display name
  tier: 'fast' | 'balanced' | 'reasoning' | 'max'
  speed: number                // 1..3 dots
  intelligence: number         // 1..3 dots
  contextTokens: number
}

interface FileNode {
  name: string; path: string; type: 'file' | 'folder'
  size?: number; children?: FileNode[]
}

interface SearchHit { path: string; line: number; text: string }

interface ToolDef { name: string; description: string; inputSchema: object }

interface AgentTask {
  modelId: string
  mode: 'chat' | 'cowork' | 'agent'
  instructions: string
  history: AiMessage[]         // conversation so far
  workspaceRoot?: string       // enables fs/git/terminal tools
  projectInstructions?: string // custom instructions from active project
}

type AgentEvent =
  | { kind: 'plan'; steps: string[] }
  | { kind: 'step'; index: number; status: 'running' | 'done'; label: string }
  | { kind: 'status'; label: string }
  | { kind: 'tool-start'; toolCallId: string; tool: string; input: unknown }
  | { kind: 'tool-end'; toolCallId: string; ok: boolean; summary: string }
  | { kind: 'assistant-message'; text: string }
  | { kind: 'diff'; path: string; change: 'added' | 'modified'; diffUnified: string; changeSummary: string; approvalId?: string }
  | { kind: 'approval-request'; approvalId: string; tool: string; title: string; detail: string; destructive: boolean }
  | { kind: 'done'; summary: string }
  | { kind: 'error'; error: string }

interface CuTask {
  modelId: string
  instruction: string
  provider: 'virtual' | 'windows'   // chosen by user in UI
  maxActions: number                // hard safety cap, e.g. 50
}

type CuAction =
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'double' }
  | { type: 'move'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; x: number; y: number; amount: number }
  | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { type: 'wait'; ms: number }
  | { type: 'open_app'; name: string }
  | { type: 'focus_window'; title: string }
```

## Conventions

- Coordinates in `CuAction` are normalized 0..1000 relative to screen/frame
  dimensions (avoids DPI bugs end-to-end).
- All timestamps are ISO-8601 strings; all ids UUIDv4 strings.
- Errors: commands reject with a human-readable string; the UI maps known
  failures to friendly cards (never raw dumps).
- The mock AI provider always answers (typewriter text) so the whole UI is
  demoable with zero keys configured.
