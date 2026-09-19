// Mirror of docs/BRIDGE.md shared types.

export type Role = 'user' | 'assistant' | 'system'

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string }

export interface AiMessage {
  role: Role
  parts: MessagePart[]
}

export interface AssistantResult {
  text: string
  stopReason: 'end' | 'tool' | 'aborted' | 'error'
}

export interface ModelInfo {
  id: string
  provider: string
  label: string
  tier: 'fast' | 'balanced' | 'reasoning' | 'max'
  speed: number
  intelligence: number
  contextTokens: number
}

export interface AiSendRequest {
  requestId: string
  modelId: string
  system?: string
  messages: AiMessage[]
  maxTokens?: number
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'folder'
  size?: number
  children?: FileNode[]
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface FolderPick {
  name: string
  path: string
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: object
}

export interface AgentTask {
  modelId: string
  mode: 'chat' | 'cowork' | 'agent' | 'plan'
  instructions: string
  history: AiMessage[]
  workspaceRoot?: string
  projectInstructions?: string
}

export type AgentEvent =
  | { kind: 'plan'; steps: string[] }
  | { kind: 'step'; index: number; status: 'running' | 'done'; label: string }
  | { kind: 'status'; label: string }
  | { kind: 'tool-start'; toolCallId: string; tool: string; input: unknown }
  | { kind: 'tool-end'; toolCallId: string; ok: boolean; summary: string }
  | { kind: 'assistant-message'; text: string }
  | {
      kind: 'diff'
      path: string
      change: 'added' | 'modified'
      diffUnified: string
      changeSummary: string
      approvalId?: string
    }
  | {
      kind: 'approval-request'
      approvalId: string
      tool: string
      title: string
      detail: string
      destructive: boolean
    }
  | { kind: 'done'; summary: string }
  | { kind: 'error'; error: string }

export interface CuTask {
  modelId: string
  instruction: string
  provider: 'virtual' | 'windows'
  maxActions: number
}

export type CuAction =
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'double' }
  | { type: 'move'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; x: number; y: number; amount: number }
  | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { type: 'wait'; ms: number }
  | { type: 'open_app'; name: string }
  | { type: 'focus_window'; title: string }

export type NotifyLevel = 'info' | 'success' | 'warn' | 'error'

// Event payload shapes (core → renderer)
export type EventPayloads = {
  'ai-chunk': { requestId: string; delta: string }
  'ai-done': { requestId: string; message: AssistantResult }
  'ai-error': { requestId: string; error: string }
  'term-data': { terminalId: string; data: string }
  'term-exit': { terminalId: string; exitCode: number }
  'agent-event': { runId: string; event: AgentEvent }
  'cu-status': { sessionId: string; phase: string; detail: string }
  'cu-frame': { sessionId: string; jpegBase64: string; width: number; height: number }
  'cu-action': { sessionId: string; action: CuAction; result: string }
  'cu-permission': { sessionId: string; promptId: string; title: string; detail: string; destructive: boolean }
  'cu-done': { sessionId: string; summary: string }
  'cu-error': { sessionId: string; error: string }
  notify: { level: NotifyLevel; title: string; body?: string }
}

// ---------------------------------------------------------------------------
// Account (orinai.org sign-in)
// ---------------------------------------------------------------------------

export interface AuthSession {
  uid: string
  name: string
  email: string
  phone: string
}

export interface AuthStatus {
  signedIn: boolean
  session: AuthSession | null
}

// Device-flow sign-in handoff (browser approves on orinai.org)
export interface AuthDeviceStart {
  deviceCode: string
  userCode: string
  verifyUrl: string
  expiresInSecs: number
}


// Provider preset from providers_list (Settings models page, welcome BYOK gate)
export interface ProviderInfo {
  id: string
  label: string
  baseUrl: string
  keyRequired: boolean
  docsUrl: string
  hasKey: boolean
}
