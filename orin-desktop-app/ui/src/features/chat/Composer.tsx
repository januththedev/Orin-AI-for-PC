import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react'
import { ArrowUp, ChevronDown, Mic, Plus, Square } from 'lucide-react'
import { bridge } from '../../bridge/client'
import type { MessagePart, ModelInfo } from '../../bridge/types'
import type { ChatMode } from '../../stores/chatsStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { FileChip, type ChipKind } from '../../components/FileChip'
import { Dropdown, DropdownItem, DropdownSectionLabel } from '../../components/Dropdown'
import './Composer.css'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComposerProps {
  mode: ChatMode
  /** Bound control for the Chat/Cowork/Agent segmented pill. */
  onModeChange?: (mode: ChatMode) => void
  onSend: (text: string, opts?: { imageParts?: MessagePart[] }) => void
  /** While streaming the Send slot becomes a Stop button. */
  streaming?: boolean
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  /** Knowledge-file names offered by the "@" mention menu. */
  mentionOptions?: string[]
}

interface Attachment {
  id: string
  name: string
  size: number
  kind: ChipKind
  /** Full data URL (images only) for thumbnails. */
  dataUrl?: string
  /** Base64 payload without the data-url prefix (images only). */
  base64?: string
  mediaType?: 'image/png' | 'image/jpeg'
  /** Inlined text content for doc/code attachments. */
  content?: string
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const SLASH_COMMANDS: Array<{ id: string; label: string; template: string }> = [
  { id: 'explain', label: 'Explain code', template: 'Explain what this code does:\n\n' },
  { id: 'brainstorm', label: 'Brainstorm', template: 'Brainstorm ideas for ' },
  { id: 'write-docs', label: 'Write documentation', template: 'Write documentation for ' },
  { id: 'review', label: 'Review files', template: 'Review these files and suggest improvements:\n\n' },
  { id: 'debug', label: 'Debug an error', template: 'Debug this error and propose a fix:\n\n' },
  { id: 'build', label: 'Build an app', template: 'Build an app that ' },
]

const MODES: Array<{ id: ChatMode; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'cowork', label: 'Cowork' },
  { id: 'agent', label: 'Agent' },
]

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compat: 'OpenAI-compatible',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  gemini: 'Google Gemini',
  mistral: 'Mistral',
  xai: 'xAI (Grok)',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  together: 'Together',
  fireworks: 'Fireworks',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  vllm: 'vLLM (local)',
  litellm: 'LiteLLM proxy',
  custom: 'Custom',
  mock: 'Offline',
  orin_cloud: 'Orin Cloud',
  orin: 'Orin Cloud',
}

const TIER_DOT: Record<ModelInfo['tier'], string> = {
  fast: 'var(--success)',
  balanced: 'var(--accent)',
  reasoning: 'var(--info)',
  max: 'var(--warn)',
}

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'css',
  'scss', 'html', 'vue', 'svelte', 'json', 'yml', 'yaml', 'toml', 'xml', 'lua',
])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'])

const INLINE_TEXT_LIMIT = 60_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function kindOfFile(file: File): ChipKind {
  if (file.type.startsWith('image/')) return 'image'
  const ext = extensionOf(file.name)
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  return 'doc'
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** Compose the final outgoing text: user text plus attachment context blocks. */
function composeOutgoingText(text: string, attachments: Attachment[]): string {
  const chunks: string[] = []
  const base = text.trim()
  if (base) chunks.push(base)
  for (const attachment of attachments) {
    if ((attachment.kind === 'doc' || attachment.kind === 'code') && attachment.content != null) {
      const lang = attachment.kind === 'code' ? extensionOf(attachment.name) : ''
      chunks.push(`**${attachment.name}**\n\`\`\`${lang}\n${attachment.content}\n\`\`\``)
    } else {
      chunks.push(`(attached file: ${attachment.name})`)
    }
  }
  return chunks.join('\n\n')
}

function imagePartsOf(attachments: Attachment[]): MessagePart[] {
  return attachments
    .filter((a) => a.kind === 'image' && a.base64 != null && a.mediaType != null)
    .map((a) => ({ type: 'image', mediaType: a.mediaType!, base64: a.base64! }) as MessagePart)
}

function Dots({ count }: { count: number }) {
  return (
    <span className="model-dots" aria-hidden="true">
      {[1, 2, 3].map((dot) => (
        <span key={dot} className={`model-dot ${dot <= count ? 'on' : ''}`} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Composer({
  mode,
  onModeChange,
  onSend,
  streaming = false,
  onStop,
  placeholder = 'How can I help you today?',
  autoFocus = false,
  mentionOptions,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)

  const defaultModelId = useSettingsStore((state) => state.defaultModelId)
  const updateSettings = useSettingsStore((state) => state.update)

  const [models, setModels] = useState<ModelInfo[]>([])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- model catalog -----------------------------------------------------
  // Static catalog first (instant, works offline), then live OpenRouter
  // models merged in — the picker always reflects the current catalog,
  // never a frozen list.
  useEffect(() => {
    let cancelled = false
    bridge
      .modelsList()
      .then((list) => {
        if (!cancelled) setModels(list)
        return bridge.modelsFetch('openrouter').catch(() => [] as ModelInfo[])
      })
      .then((live) => {
        if (cancelled || live.length === 0) return
        setModels((prev) => mergeLiveModels(prev, live))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const activeModel = models.find((m) => m.id === defaultModelId) ?? null

  // -- auto-growing textarea ----------------------------------------------
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [text, resizeTextarea])

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  // -- fake mic ------------------------------------------------------------
  useEffect(() => {
    if (recording) {
      recordTimer.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    } else if (recordTimer.current) {
      clearInterval(recordTimer.current)
      recordTimer.current = null
    }
    return () => {
      if (recordTimer.current) {
        clearInterval(recordTimer.current)
        recordTimer.current = null
      }
    }
  }, [recording])

  const toggleRecording = () => {
    setRecording((was) => !was)
    setRecordSeconds(0)
  }

  const recordLabel = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(
    recordSeconds % 60,
  ).padStart(2, '0')}`

  // -- suggestion menus (slash + mentions) ---------------------------------
  const slashQuery = /^\/([\w -]*)$/.exec(text.trimEnd())?.[1] ?? null
  const mentionMatch = mentionOptions?.length ? /(?:^|\s)@([\w.-]*)$/.exec(text)?.[1] : null

  const slashItems = useMemo(() => {
    if (slashQuery == null) return []
    const needle = slashQuery.trim().toLowerCase()
    return SLASH_COMMANDS.filter((cmd) => cmd.label.toLowerCase().includes(needle))
  }, [slashQuery])

  const mentionItems = useMemo(() => {
    if (mentionMatch == null) return []
    const needle = mentionMatch.toLowerCase()
    return mentionOptions!.filter((name) => name.toLowerCase().includes(needle))
  }, [mentionMatch, mentionOptions])

  // The menu is derived from the text itself; Escape just hides it until the
  // next keystroke.
  const [menuDismissed, setMenuDismissed] = useState(false)
  useEffect(() => setMenuDismissed(false), [text])

  const suggestionsActive =
    !menuDismissed && (slashItems.length > 0 || mentionItems.length > 0)
  const [activeIndex, setActiveIndex] = useState(0)
  const activeSuggestions = slashItems.length > 0 ? slashItems.map((c) => c.label) : mentionItems
  useEffect(() => setActiveIndex(0), [text])

  const pickSuggestion = (index: number) => {
    if (slashItems.length > 0) {
      const command = slashItems[index]
      if (!command) return
      setText(command.template)
    } else {
      const name = mentionItems[index]
      if (!name) return
      setText((current) => current.replace(/(?:^|\s)@([\w.-]*)$/, (lead) => `${lead}@${name} `))
    }
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  // -- attachments ----------------------------------------------------------
  const addFiles = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const kind = kindOfFile(file)
        const id = crypto.randomUUID()
        if (kind === 'image') {
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = typeof reader.result === 'string' ? reader.result : ''
            const comma = dataUrl.indexOf(',')
            setAttachments((prev) => [
              ...prev,
              {
                id,
                name: file.name || 'image',
                size: file.size,
                kind,
                dataUrl,
                base64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
                mediaType: file.type.includes('jpeg') ? 'image/jpeg' : 'image/png',
              },
            ])
          }
          reader.readAsDataURL(file)
        } else if (kind === 'archive') {
          setAttachments((prev) => [...prev, { id, name: file.name, size: file.size, kind }])
        } else {
          const reader = new FileReader()
          reader.onload = () => {
            let content = typeof reader.result === 'string' ? reader.result : ''
            if (content.length > INLINE_TEXT_LIMIT) {
              content = `${content.slice(0, INLINE_TEXT_LIMIT)}\n…[truncated]`
            }
            setAttachments((prev) => [...prev, { id, name: file.name, size: file.size, kind, content }])
          }
          reader.readAsText(file)
        }
      }
    },
    [],
  )

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  // -- sending ---------------------------------------------------------------
  const canSend = Boolean(text.trim()) || attachments.length > 0

  const submit = () => {
    if (streaming || !canSend) return
    const imageParts = imagePartsOf(attachments)
    onSend(composeOutgoingText(text, attachments), imageParts.length > 0 ? { imageParts } : undefined)
    setText('')
    setAttachments([])
    setRecording(false)
    setRecordSeconds(0)
    requestAnimationFrame(resizeTextarea)
  }

  // -- key handling ------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return

    if (suggestionsActive) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((i) => (i + 1) % activeSuggestions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((i) => (i - 1 + activeSuggestions.length) % activeSuggestions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        pickSuggestion(activeIndex)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuDismissed(true)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onChangeText = (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)

  // -- drag & drop + paste -------------------------------------------------------
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    )
    if (images.length === 0) return
    event.preventDefault()
    const files = images.map((item) => item.getAsFile()).filter((f): f is File => f != null)
    addFiles(files)
  }

  // ---------------------------------------------------------------------------
  return (
    <div
      className={`composer ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* slash / mention suggestion menu */}
      {suggestionsActive && (
        <div className="composer-suggest" role="listbox">
          {(slashItems.length > 0 ? slashItems : mentionItems).map((entry, index) => {
            const label = typeof entry === 'string' ? entry : entry.label
            return (
              <button
                key={typeof entry === 'string' ? entry : entry.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`composer-suggest-item ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pickSuggestion(index)
                }}
              >
                <span className="composer-suggest-glyph">{slashItems.length > 0 ? '/' : '@'}</span>
                {label}
              </button>
            )
          })}
        </div>
      )}

      {/* attachment chips */}
      {attachments.length > 0 && (
        <div className="composer-chips">
          {attachments.map((a) => (
            <FileChip key={a.id} name={a.name} size={a.size} kind={a.kind} dataUrl={a.dataUrl} onRemove={() => removeAttachment(a.id)} />
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        value={text}
        onChange={onChangeText}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={1}
        spellCheck={false}
        aria-label="Message Orin"
      />

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className="composer-icon-button"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={16} />
          </button>

          <span className="composer-divider" />

          <div className="mode-selector" role="radiogroup" aria-label="Conversation mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={`mode-option ${mode === m.id ? 'active' : ''}`}
                onClick={() => onModeChange?.(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <Dropdown
            align="start"
            className="model-selector"
            panelClassName="model-menu"
            trigger={
              <>
                <span className="model-tier-dot" style={{ background: TIER_DOT[activeModel?.tier ?? 'balanced'] }} />
                <span className="model-label">{activeModel?.label ?? defaultModelId.split('/').pop()}</span>
                <ChevronDown size={12} />
              </>
            }
          >
            {(close) =>
              models.length === 0 ? (
                <div className="model-empty">No models available</div>
              ) : (
                groupModels(models).map(([provider, providerModels]) => (
                  <div key={provider}>
                    <DropdownSectionLabel>{PROVIDER_LABELS[provider] ?? provider}</DropdownSectionLabel>
                    {providerModels.map((m) => (
                      <DropdownItem
                        key={m.id}
                        selected={m.id === defaultModelId}
                        onSelect={() => {
                          updateSettings({ defaultModelId: m.id })
                          close()
                        }}
                        label={<span className="model-item-name">{m.label}</span>}
                        hint={
                          <span className="model-item-meta">
                            <Dots count={m.speed} />
                            <Dots count={m.intelligence} />
                            <span className="model-context">{formatContextTokens(m.contextTokens)}</span>
                          </span>
                        }
                      />
                    ))}
                  </div>
                ))
              )
            }
          </Dropdown>
        </div>

        <div className="composer-toolbar-right">
          {recording ? (
            <button type="button" className="mic-recording" onClick={toggleRecording} title="Cancel recording" aria-live="polite">
              <span className="mic-pulse" />
              <span className="mic-counter">{recordLabel}</span>
            </button>
          ) : (
            <button type="button" className="composer-icon-button" onClick={toggleRecording} title="Voice input (soon)" aria-label="Voice input">
              <Mic size={15} />
            </button>
          )}

          {streaming ? (
            <button type="button" className="composer-send stop" onClick={onStop} title="Stop generating" aria-label="Stop generating">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              onClick={submit}
              disabled={!canSend}
              title="Send message"
              aria-label="Send message"
            >
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Group models by provider, preserving first-seen order. */
function groupModels(models: ModelInfo[]): Array<[ModelInfo['provider'], ModelInfo[]]> {
  const groups = new Map<ModelInfo['provider'], ModelInfo[]>()
  for (const model of models) {
    const bucket = groups.get(model.provider)
    if (bucket) bucket.push(model)
    else groups.set(model.provider, [model])
  }
  return Array.from(groups.entries())
}

/** Merge a live fetch into the static catalog: known ids keep their curated
 * metadata, unknown live ids are appended so new/stealth models appear. */
function mergeLiveModels(base: ModelInfo[], live: ModelInfo[]): ModelInfo[] {
  const seen = new Set(base.map((m) => m.id))
  const extra = live.filter((m) => !seen.has(m.id))
  return extra.length > 0 ? [...base, ...extra] : base
}
