import { create } from 'zustand'
import { bridge } from '../bridge/client'
import type { AiMessage, MessagePart } from '../bridge/types'
import { useSettingsStore } from './settingsStore'

export type ChatMode = 'chat' | 'cowork' | 'agent' | 'computer'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  pending?: boolean
  error?: string
  mode?: ChatMode
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  mode: ChatMode
  projectId: string | null
  pinned: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
}

interface ChatsState {
  conversations: Conversation[]
  activeId: string | null
  hydrate: () => Promise<void>
  createChat: (mode?: ChatMode, projectId?: string | null) => string
  selectChat: (id: string) => void
  renameChat: (id: string, title: string) => void
  deleteChat: (id: string) => void
  pinChat: (id: string, pinned: boolean) => void
  archiveChat: (id: string, archived: boolean) => void
  moveToProject: (id: string, projectId: string | null) => void
  setMode: (id: string, mode: ChatMode) => void
  sendMessage: (text: string, opts?: { imageParts?: import('../bridge/types').MessagePart[] }) => void
  stopStreaming: () => void
}

const CHATS_KEY = 'chats'
let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Only conversations with at least one message are worth keeping — an
 * untouched "new chat" must never be saved, locally or to the cloud. */
export const withMessages = (conversations: Conversation[]) =>
  conversations.filter((c) => c.messages.length > 0)
/** Restarting with a stuck `pending` response would freeze the UI on a
 * ghost "thinking" state — settle them on load. */
export const settlePending = (conversations: Conversation[]) =>
  conversations.map((c) => ({
    ...c,
    messages: c.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
  }))
const persist = (conversations: Conversation[]) => {
  clearTimeout(saveTimer)
  const kept = withMessages(conversations)
  saveTimer = setTimeout(() => bridge.storeSet(CHATS_KEY, kept).catch(() => {}), 350)
  // Every mutation funnels through here — one hook covers cloud sync.
  void import('./cloudSync').then(({ scheduleCloudSync }) => scheduleCloudSync())
}

// Disposer of the in-flight stream, kept where stopStreaming can reach it.
// Purely additive — existing actions keep their signatures and behavior.
let activeStreamDisposer: (() => void) | null = null

const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()

const titleFrom = (text: string) => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean || 'New conversation'
}

export const useChatsStore = create<ChatsState>((set, get) => ({
  conversations: [],
  activeId: null,

  hydrate: async () => {
    try {
      const saved = await bridge.storeGet<Conversation[]>(CHATS_KEY)
      if (Array.isArray(saved) && saved.length) {
        const kept = settlePending(withMessages(saved))
        if (kept.length > 0) set({ conversations: kept, activeId: kept[0].id })
      }
    } catch {
      // fresh install
    }
  },

  createChat: (mode = 'chat', projectId = null) => {
    const chat: Conversation = {
      id: uid(),
      title: 'New conversation',
      messages: [],
      mode,
      projectId,
      pinned: false,
      archived: false,
      createdAt: now(),
      updatedAt: now(),
    }
    set((state) => ({ conversations: [chat, ...state.conversations], activeId: chat.id }))
    persist(get().conversations)
    return chat.id
  },

  selectChat: (id) => set({ activeId: id }),

  renameChat: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((chat) => (chat.id === id ? { ...chat, title } : chat)),
    })),

  deleteChat: (id) =>
    set((state) => {
      const conversations = state.conversations.filter((chat) => chat.id !== id)
      return { conversations, activeId: state.activeId === id ? (conversations[0]?.id ?? null) : state.activeId }
    }),

  pinChat: (id, pinned) =>
    set((state) => ({ conversations: state.conversations.map((chat) => (chat.id === id ? { ...chat, pinned } : chat)) })),

  archiveChat: (id, archived) =>
    set((state) => ({ conversations: state.conversations.map((chat) => (chat.id === id ? { ...chat, archived } : chat)) })),

  moveToProject: (id, projectId) =>
    set((state) => ({ conversations: state.conversations.map((chat) => (chat.id === id ? { ...chat, projectId } : chat)) })),

  setMode: (id, mode) =>
    set((state) => ({ conversations: state.conversations.map((chat) => (chat.id === id ? { ...chat, mode } : chat)) })),

  sendMessage: (text, opts) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const state = get()
    let chat = state.conversations.find((c) => c.id === state.activeId)
    if (!chat) {
      get().createChat()
      chat = get().conversations.find((c) => c.id === get().activeId)
      if (!chat) return
    }
    const chatId = chat.id
    const responseId = uid()
    const isFirstMessage = chat.messages.length === 0
    const userMessage: ChatMessage = { id: uid(), role: 'user', content: trimmed, createdAt: now(), mode: chat.mode }
    const assistantMessage: ChatMessage = { id: responseId, role: 'assistant', content: '', createdAt: now(), pending: true, mode: chat.mode }

    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === chatId
          ? {
              ...c,
              title: isFirstMessage ? titleFrom(trimmed) : c.title,
              messages: [...c.messages, userMessage, assistantMessage],
              updatedAt: now(),
            }
          : c,
      ),
    }))
    // The prompt itself is memory from here — don't wait for the first chunk.
    persist(get().conversations)

    const modelId = useSettingsStore.getState().defaultModelId
    const history: AiMessage[] = chat.messages
      .slice(-16)
      .map((m) => ({ role: m.role, parts: [{ type: 'text', text: m.content }] }))
    const messages: AiMessage[] = [
      ...history,
      {
        role: 'user',
        parts: [...(opts?.imageParts ?? []), { type: 'text', text: trimmed }],
      },
    ]

    const patchResponse = (patch: Partial<ChatMessage>) =>
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === chatId
            ? { ...c, messages: c.messages.map((m) => (m.id === responseId ? { ...m, ...patch } : m)) }
            : c,
        ),
      }))

    const cancel = bridge.sendAi(messages, { modelId }, {
      onChunk: (delta) => {
        const current = get().conversations.find((c) => c.id === chatId)?.messages.find((m) => m.id === responseId)
        patchResponse({ content: (current?.content ?? '') + delta, pending: true })
      },
      onDone: (full, aborted) => {
        activeStreamDisposer = null
        patchResponse({ content: full || ' ', pending: false })
        persist(get().conversations)
        if (aborted) cancel()
      },
      onError: (error) => {
        activeStreamDisposer = null
        patchResponse({ pending: false, error, content: '' })
        persist(get().conversations)
      },
    })
    activeStreamDisposer = cancel
  },

  stopStreaming: () => {
    // Abort the in-flight request through bridge.sendAi's disposer, then mark
    // any pending response of the active chat as finished so the UI unblocks.
    activeStreamDisposer?.()
    activeStreamDisposer = null
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === s.activeId
          ? { ...c, messages: c.messages.map((m) => (m.pending ? { ...m, pending: false } : m)) }
          : c,
      ),
    }))
    persist(get().conversations)
  },
}))

export const selectActiveChat = (state: ChatsState) => state.conversations.find((c) => c.id === state.activeId) ?? null
