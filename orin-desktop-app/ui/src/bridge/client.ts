// Typed bridge to the Rust core. When the UI runs in a plain browser (vite dev
// without Tauri), a mock backend answers every command so all features stay
// developable; inside the app the real commands are used.
import type {
  AgentEvent,
  AgentTask,
  AiMessage,
  AiSendRequest,
  AuthDeviceStart,
  AuthSession,
  AuthStatus,
  CuTask,
  EventPayloads,
  FileNode,
  FolderPick,
  ModelInfo,
  ProviderInfo,
  McpServer,
  SearchHit,
} from './types'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export type { AuthSession, AuthStatus, AuthDeviceStart } from './types'

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri) return mockInvoke<T>(command, args)
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

type Listener<T> = (payload: T) => void
const mockListeners = new Map<string, Set<Listener<never>>>()

async function listen<K extends keyof EventPayloads>(
  event: K,
  handler: Listener<EventPayloads[K]>,
): Promise<() => void> {
  if (!isTauri) {
    const set = mockListeners.get(event) ?? new Set()
    set.add(handler as never)
    mockListeners.set(event, set)
    return () => {
      set.delete(handler as never)
    }
  }
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<EventPayloads[K]>(event, (e) => handler(e.payload))
  return unlisten
}

// Emit from the mock backend (browser dev mode only).
export function mockEmit<K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) {
  mockListeners.get(event)?.forEach((handler) => (handler as Listener<typeof payload>)(payload))
}

// ---------------------------------------------------------------------------
// Mock backend (browser dev)
// ---------------------------------------------------------------------------

const mockModels: ModelInfo[] = [
  { id: 'mock/orin-offline', provider: 'mock', label: 'Orin Offline', tier: 'balanced', speed: 3, intelligence: 1, contextTokens: 32000 },
  { id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', label: 'Claude Sonnet 4.5', tier: 'balanced', speed: 2, intelligence: 3, contextTokens: 200000 },
  { id: 'anthropic/claude-haiku-4', provider: 'anthropic', label: 'Claude Haiku 4', tier: 'fast', speed: 3, intelligence: 2, contextTokens: 200000 },
  { id: 'openai_compat/gpt-5', provider: 'openai_compat', label: 'GPT-5 (compatible)', tier: 'reasoning', speed: 1, intelligence: 3, contextTokens: 400000 },
]

const memoryStore = new Map<string, unknown>()

function mockInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  switch (command) {
    case 'models_list':
      return Promise.resolve(mockModels as T)
    case 'provider_has_key':
      return Promise.resolve(false as T)
    case 'telegram_has_token':
      return Promise.resolve(false as T)
    case 'connector_has_cred':
      return Promise.resolve(false as T)
    case 'connector_test':
      return Promise.reject(new Error('Connectors need the Rust core — run npm run app:dev') as unknown as T)
    case 'mcp_servers':
      return Promise.resolve([] as T)
    case 'mcp_test':
      return Promise.reject(new Error('MCP needs the Rust core — run npm run app:dev') as unknown as T)
    case 'store_get':
      return Promise.resolve((memoryStore.get(args.key as string) ?? null) as T)
    case 'store_set':
      memoryStore.set(args.key as string, args.value)
      return Promise.resolve(undefined as T)
    case 'store_delete':
      memoryStore.delete(args.key as string)
      return Promise.resolve(undefined as T)
    case 'app_info':
      return Promise.resolve({ version: 'dev-browser', os: 'browser-mock' } as T)
    case 'cu_available_providers':
      return Promise.resolve(['virtual'] as T)
    case 'auth_status':
      return Promise.resolve({ signedIn: false, session: null } as T)
    case 'backend_status':
      return Promise.resolve({ reachable: true, latencyMs: 1, httpStatus: 200 } as T)
    case 'auth_logout':
      return Promise.resolve(undefined as T)
    case 'auth_device_start':
      return Promise.resolve({
        deviceCode: 'mock-device-code',
        userCode: 'DEMO-CODE',
        verifyUrl: 'https://orinai.org',
        expiresInSecs: 600,
      } as T)
    case 'auth_device_wait': {
      // Browser dev has no real approval page — sign in after a beat.
      return new Promise<T>((resolve) =>
        setTimeout(
          () => resolve({ uid: 'mock-user', name: 'Browser Dev', email: 'dev@orin.ai', phone: '' } as T),
          1500,
        ),
      )
    }
    case 'open_external':
      return Promise.resolve(undefined as T)
    case 'sync_pull':
      return Promise.resolve({ blob: null, updatedAt: null } as T)
    case 'sync_push':
      return Promise.resolve(undefined as T)
    case 'providers_list':
      return Promise.resolve([
        { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', keyRequired: true, docsUrl: 'https://console.anthropic.com/settings/keys', hasKey: false },
        { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true, docsUrl: 'https://platform.openai.com/api-keys', hasKey: false },
        { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, docsUrl: 'https://openrouter.ai/settings/keys', hasKey: false },
        { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, docsUrl: 'https://platform.deepseek.com/api_keys', hasKey: false },
        { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, docsUrl: 'https://console.groq.com/keys', hasKey: false },
        { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true, docsUrl: 'https://aistudio.google.com/apikey', hasKey: false },
        { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', keyRequired: false, docsUrl: 'https://ollama.com', hasKey: false },
        { id: 'openai_compat', label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', keyRequired: true, docsUrl: '', hasKey: false },
      ] as T)
    case 'models_fetch':
      return Promise.resolve([] as T)
    case 'dialog_pick_folder':
      return Promise.resolve(null as T)
    case 'ai_send': {
      const request = args.req as AiSendRequest
      const prompt =
        request.messages.at(-1)?.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ') ?? ''
      ;(async () => {
        const reply =
          `Here's my take on “${prompt}”.\n\nI'm the **browser-dev mock responder** — run \`npm run app:dev\` for the real Rust core. ` +
          `Everything else in this workspace is live.`
        for (const word of reply.split(/(?<= )/)) {
          mockEmit('ai-chunk', { requestId: request.requestId, delta: word })
          await new Promise((resolve) => setTimeout(resolve, 14))
        }
        mockEmit('ai-done', { requestId: request.requestId, message: { text: reply, stopReason: 'end' } })
      })()
      return Promise.resolve(request.requestId as T)
    }
    default:
      return Promise.reject(new Error(`${command} is not available in browser dev mode`))
  }
}

// Subscribe to one or more events with a synchronous disposer, even though
// the underlying registration is asynchronous. Handlers accept their concrete
// payload type; `(payload: never) => …` keeps each entry independently typed.
function subscribe(
  entries: Array<[keyof EventPayloads, (payload: never) => boolean | void]>,
  onDispose?: () => void,
): () => void {
  let disposed = false
  const offs: Array<() => void> = []
  Promise.all(
    entries.map(([event, handler]) =>
      listen(event, handler as never).then((off) => {
        if (disposed) off()
        else offs.push(off)
      }),
    ),
  ).catch(() => {})
  return () => {
    disposed = true
    offs.forEach((off) => off())
    onDispose?.()
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const bridge = {
  isTauri,

  // persistence
  storeGet: <T>(key: string) => invoke<T | null>('store_get', { key }),
  storeSet: (key: string, value: unknown) => invoke<void>('store_set', { key, value }),
  storeDelete: (key: string) => invoke<void>('store_delete', { key }),

  // ai
  aiSend: (req: AiSendRequest) => invoke<string>('ai_send', { req }),
  aiAbort: (requestId: string) => invoke<void>('ai_abort', { requestId }),
  modelsList: (): Promise<ModelInfo[]> => invoke('models_list'),
  providersList: (): Promise<ProviderInfo[]> => invoke('providers_list'),
  modelsFetch: (presetId: string): Promise<ModelInfo[]> =>
    invoke('models_fetch', { presetId }),
  providerSetKey: (provider: string, key: string) => invoke<void>('provider_set_key', { provider, key }),
  providerHasKey: (provider: string): Promise<boolean> => invoke('provider_has_key', { provider }),

  // telegram (bot token lives in env/keyring only — never in code)
  telegramSetToken: (token: string) => invoke<void>('telegram_set_token', { token }),
  telegramHasToken: (): Promise<boolean> => invoke('telegram_has_token'),
  telegramNotify: (chatId: string, text: string): Promise<void> =>
    invoke('telegram_notify', { chatId, text }),

  // connectors (service creds in OS keyring; validated live; agent-safe)
  connectorSetCred: (id: string, token: string) => invoke<void>('connector_set_cred', { id, token }),
  connectorHasCred: (id: string): Promise<boolean> => invoke('connector_has_cred', { id }),
  connectorTest: (id: string): Promise<string> => invoke('connector_test', { id }),
  connectorRemove: (id: string) => invoke<void>('connector_remove', { id }),

  // mcp servers (URL + key; agent discovers tools itself)
  mcpServers: (): Promise<McpServer[]> => invoke('mcp_servers'),
  mcpAddServer: (name: string, url: string): Promise<string> => invoke('mcp_add_server', { name, url }),
  mcpRemoveServer: (id: string) => invoke<void>('mcp_remove_server', { id }),
  mcpSetKey: (id: string, key: string) => invoke<void>('mcp_set_key', { id, key }),
  mcpTest: (id: string): Promise<string> => invoke('mcp_test', { id }),

  // files
  pickFolder: (): Promise<FolderPick | null> => invoke('dialog_pick_folder'),
  readDir: (path: string, depth = 3): Promise<FileNode[]> => invoke('fs_read_dir', { path, depth }),
  readFile: (path: string): Promise<string> => invoke('fs_read_file', { path }),
  writeFile: (path: string, content: string) => invoke<void>('fs_write_file', { path, content }),
  fileExists: (path: string) => invoke<boolean>('fs_exists', { path }),
  gitStatus: (root: string): Promise<Record<string, string>> => invoke('git_status', { root }),
  searchWorkspace: (root: string, query: string, maxResults = 60): Promise<SearchHit[]> =>
    invoke('search_workspace', { root, query, maxResults }),

  // terminal
  termCreate: (cwd?: string) => invoke<string>('term_create', { cwd: cwd ?? null }),
  termWrite: (terminalId: string, data: string) => invoke<void>('term_write', { terminalId, data }),
  termResize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>('term_resize', { terminalId, cols, rows }),
  termKill: (terminalId: string) => invoke<void>('term_kill', { terminalId }),

  // agent
  agentRun: (task: AgentTask) => invoke<string>('agent_run', { task }),
  agentStop: (runId: string) => invoke<void>('agent_stop', { runId }),
  approvalRespond: (approvalId: string, approved: boolean) =>
    invoke<void>('approval_respond', { approvalId, approved }),

  // computer use
  cuStart: (task: CuTask) => invoke<string>('cu_start', { task }),
  cuStop: (sessionId: string) => invoke<void>('cu_stop', { sessionId }),
  cuPermissionRespond: (promptId: string, allowed: boolean) =>
    invoke<void>('cu_permission_respond', { promptId, allowed }),
  cuProviders: (): Promise<string[]> => invoke('cu_available_providers'),

  // account + sync (orinai.org)
  authLogin: (identifier: string, password: string) =>
    invoke<AuthSession>('auth_login', { identifier, password }),
  authRegister: (name: string, identifier: string, password: string) =>
    invoke<AuthSession>('auth_register', { name, identifier, password }),
  // Device flow: start opens orinai.org in the system browser; wait resolves
  // once the user approves the code there (or rejects with expired/denied).
  authDeviceStart: () => invoke<AuthDeviceStart>('auth_device_start'),
  authDeviceWait: (deviceCode: string) => invoke<AuthSession>('auth_device_wait', { deviceCode }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  authStatus: (): Promise<AuthStatus> => invoke('auth_status'),
  authLogout: () => invoke<void>('auth_logout'),
  backendStatus: (): Promise<{ reachable: boolean; latencyMs: number; httpStatus: number }> =>
    invoke('backend_status'),
  syncPull: <T = unknown>() =>
    invoke<{ blob: T | null; updatedAt: string | null }>('sync_pull'),
  syncPush: (blob: unknown, schemaVersion?: number) =>
    invoke<void>('sync_push', { blob, schemaVersion: schemaVersion ?? 1 }),

  // misc
  appInfo: () => invoke<{ version: string; os: string }>('app_info'),

  on: listen,

  sendAi(
    messages: AiMessage[],
    opts: { modelId: string; system?: string },
    handlers: {
      onChunk(delta: string): void
      onDone(text: string, aborted: boolean): void
      onError(error: string): void
    },
  ): () => void {
    const requestId = crypto.randomUUID()
    const request: AiSendRequest = { requestId, modelId: opts.modelId, system: opts.system, messages }
    invoke('ai_send', { req: request }).catch((error) => handlers.onError(String(error)))
    return subscribe(
      [
        ['ai-chunk', (p: EventPayloads['ai-chunk']) => p.requestId === requestId && handlers.onChunk(p.delta)],
        [
          'ai-done',
          (p: EventPayloads['ai-done']) => {
            if (p.requestId !== requestId) return
            handlers.onDone(p.message.text, p.message.stopReason === 'aborted')
          },
        ],
        [
          'ai-error',
          (p: EventPayloads['ai-error']) => {
            if (p.requestId !== requestId) return
            handlers.onError(p.error)
          },
        ],
      ],
      () => {
        if (isTauri) invoke('ai_abort', { requestId }).catch(() => {})
      },
    )
  },

  onAgentEvent(runId: string, handler: (event: AgentEvent) => void): () => void {
    return subscribe([
      [
        'agent-event',
        (p: EventPayloads['agent-event']) => {
          if (p.runId === runId) handler(p.event)
        },
      ],
    ])
  },
}

export type Bridge = typeof bridge
