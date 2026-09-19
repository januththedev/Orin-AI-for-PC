import { useRef, useState } from 'react'
import { Play, Square, ChevronDown, ChevronUp } from 'lucide-react'
import { bridge } from '../../bridge/client'
import { useSettingsStore } from '../../stores/settingsStore'
import type { AgentEvent } from '../../bridge/types'

interface PlanState {
  steps: string[]
  status: Record<number, 'running' | 'done'>
}

interface ToolCard {
  id: string
  tool: string
  input: unknown
  summary?: string
  ok?: boolean
}

interface DiffCard {
  id: string
  path: string
  diffUnified: string
  changeSummary: string
  approvalId?: string
  resolved?: 'accepted' | 'rejected'
}

interface ApprovalCard {
  id: string
  tool: string
  title: string
  detail: string
  destructive: boolean
  resolved?: 'accepted' | 'rejected'
}

type RunMode = 'plan' | 'agent'

export function AiPanel({ root }: { root: string | null }) {
  const modelId = useSettingsStore((state) => state.defaultModelId)
  const [instructions, setInstructions] = useState('')
  const [running, setRunning] = useState(false)
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [statuses, setStatuses] = useState<string[]>([])
  const [tools, setTools] = useState<ToolCard[]>([])
  const [diffs, setDiffs] = useState<DiffCard[]>([])
  const [approvals, setApprovals] = useState<ApprovalCard[]>([])
  const [mode, setMode] = useState<RunMode>('agent')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const runIdRef = useRef<string | null>(null)
  const offRef = useRef<(() => void) | null>(null)

  const reset = () => {
    setPlan(null)
    setStatuses([])
    setTools([])
    setDiffs([])
    setApprovals([])
    setResult(null)
  }

  const stop = () => {
    if (runIdRef.current) bridge.agentStop(runIdRef.current).catch(() => {})
    setRunning(false)
  }

  const run = async () => {
    if (!instructions.trim() || running) return
    reset()
    setRunning(true)
    try {
      const runId = await bridge.agentRun({
        modelId,
        mode,
        instructions: instructions.trim(),
        history: [],
        workspaceRoot: root ?? undefined,
      })
      runIdRef.current = runId
      offRef.current?.()
      offRef.current = bridge.onAgentEvent(runId, (event: AgentEvent) => handleEvent(event))
    } catch (error) {
      setResult({ ok: false, text: String(error) })
      setRunning(false)
    }
  }

  const handleEvent = (event: AgentEvent) => {
    switch (event.kind) {
      case 'plan':
        setPlan({ steps: event.steps, status: {} })
        break
      case 'step':
        setPlan((prev) =>
          prev ? { ...prev, status: { ...prev.status, [event.index]: event.status } } : prev,
        )
        break
      case 'status':
        setStatuses((prev) => [...prev.slice(-20), event.label])
        break
      case 'tool-start':
        setTools((prev) => [...prev, { id: event.toolCallId, tool: event.tool, input: event.input }])
        break
      case 'tool-end':
        setTools((prev) =>
          prev.map((card) => (card.id === event.toolCallId ? { ...card, summary: event.summary, ok: event.ok } : card)),
        )
        break
      case 'diff':
        setDiffs((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            path: event.path,
            diffUnified: event.diffUnified,
            changeSummary: event.changeSummary,
            approvalId: event.approvalId,
          },
        ])
        break
      case 'approval-request':
        // Diff cards that carry an approval id answer it themselves (see the
        // render filter below); standalone cards cover run_command, desktop
        // tools, and anything else without a diff.
        setApprovals((prev) => {
          if (prev.some((card) => card.id === event.approvalId)) return prev
          return [
            ...prev,
            {
              id: event.approvalId,
              tool: event.tool,
              title: event.title,
              detail: event.detail,
              destructive: event.destructive,
            },
          ]
        })
        break
      case 'done':
        setResult({ ok: true, text: event.summary })
        setRunning(false)
        break
      case 'error':
        setResult({ ok: false, text: event.error })
        setRunning(false)
        break
      default:
        break
    }
  }

  const respond = async (diff: DiffCard, approved: boolean) => {
    if (diff.approvalId) await answerApproval(diff.approvalId, approved)
    else {
      setDiffs((prev) =>
        prev.map((card) => (card.id === diff.id ? { ...card, resolved: approved ? 'accepted' : 'rejected' } : card)),
      )
    }
  }

  const answerApproval = async (approvalId: string, approved: boolean) => {
    await bridge.approvalRespond(approvalId, approved).catch(() => {})
    const resolved = approved ? 'accepted' : 'rejected'
    setApprovals((prev) => prev.map((card) => (card.id === approvalId ? { ...card, resolved } : card)))
    setDiffs((prev) =>
      prev.map((card) => (card.approvalId === approvalId ? { ...card, resolved } : card)),
    )
  }

  // Approvals already owned by a diff card are answered there — show only
  // standalone ones (commands, desktop control) as their own cards.
  const standaloneApprovals = approvals.filter(
    (card) => !diffs.some((diff) => diff.approvalId === card.id),
  )

  return (
    <div className="ide-ai">
      <div className="ide-ai-head">
        <strong>AI panel</strong>
        <span className="ide-ai-model">{modelId.split('/').pop()}</span>
      </div>

      <div className="ide-ai-modes" role="radiogroup" aria-label="Agent mode">
        {(['plan', 'agent'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`ide-ai-mode ${mode === m ? 'active' : ''}`}
            onClick={() => setMode(m)}
            disabled={running}
            title={m === 'plan' ? 'Investigate only — read-only, ends with a step-by-step plan' : 'Full access — read, edit with approval, run commands with approval'}
          >
            {m === 'plan' ? 'Plan' : 'Agent · full access'}
          </button>
        ))}
      </div>

      <textarea
        className="ide-ai-input"
        placeholder={
          mode === 'plan'
            ? 'Describe what to figure out — Orin will investigate and return a plan…'
            : 'Describe a coding task — Orin will inspect the project, propose diffs, and run checks…'
        }
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        disabled={running}
      />

      {running ? (
        <button className="ide-ai-stop" onClick={stop}>
          <Square size={12} /> Stop
        </button>
      ) : (
        <button className="ide-ai-run" disabled={!instructions.trim()} onClick={run}>
          <Play size={12} /> Run task
        </button>
      )}

      <div className="ide-ai-feed">
        {!plan && statuses.length === 0 && tools.length === 0 && diffs.length === 0 && standaloneApprovals.length === 0 && !result && (
          <p className="ide-ai-empty">
            {mode === 'plan'
              ? 'Plan mode investigates read-only and returns a step-by-step plan — nothing will be changed.'
              : 'The agent\u2019s plan, tool calls, and proposed file changes appear here. File writes and commands always ask before running.'}
          </p>
        )}

        {plan && (
          <div className="ide-plan">
            {plan.steps.map((step, index) => {
              const state = plan.status[index]
              return (
                <p key={index} className={`ide-plan-step ${state ?? ''}`}>
                  <span className="ide-plan-marker">{state === 'done' ? '✓' : state === 'running' ? '●' : '○'}</span>
                  {step}
                </p>
              )
            })}
          </div>
        )}

        {statuses.map((line, index) => (
          <p key={index} className="ide-status-line">
            {line}
          </p>
        ))}

        {tools.map((card) => (
          <details key={card.id} className={`ide-tool-card ${card.ok === false ? 'failed' : ''}`}>
            <summary>
              <strong>{card.tool}</strong>
              <span>{inputSummary(card.input)}</span>
            </summary>
            <pre>{JSON.stringify(card.input, null, 2)}</pre>
            {card.summary && <p className="ide-tool-result">{card.summary}</p>}
          </details>
        ))}

        {diffs.map((diff) => (
          <DiffView key={diff.id} diff={diff} onRespond={respond} />
        ))}

        {standaloneApprovals.map((card) => (
          <div key={card.id} className={`ide-approval ${card.destructive ? 'destructive' : ''}`}>
            <div className="ide-approval-head">
              <strong>{card.title}</strong>
              <span className="ide-approval-tool">{card.tool}</span>
            </div>
            <p className="ide-approval-detail">{card.detail}</p>
            {card.resolved ? (
              <span className={`ide-diff-resolved ${card.resolved}`}>
                {card.resolved === 'accepted' ? 'Approved ✓' : 'Denied'}
              </span>
            ) : (
              <div className="ide-diff-actions">
                <button className="ide-diff-reject" onClick={() => answerApproval(card.id, false)}>
                  Deny
                </button>
                <button className="ide-diff-accept" onClick={() => answerApproval(card.id, true)}>
                  Approve
                </button>
              </div>
            )}
          </div>
        ))}

        {result && <div className={`ide-ai-result ${result.ok ? 'ok' : 'fail'}`}>{result.text}</div>}
      </div>
    </div>
  )
}

function inputSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    const first = record.path ?? record.query ?? record.command ?? record.name ?? ''
    if (first) return String(first).slice(0, 60)
  }
  return ''
}

function DiffView({
  diff,
  onRespond,
}: {
  diff: DiffCard
  onRespond: (diff: DiffCard, approved: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = diff.diffUnified.split('\n')
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length

  return (
    <div className={`ide-diff ${diff.resolved ? 'resolved' : ''}`}>
      <div className="ide-diff-head">
        <button className="ide-diff-path" onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {diff.path.split(/[\\/]/).pop()}
        </button>
        <span className="ide-diff-stats">
          <em className="added">+{added}</em> <em className="removed">−{removed}</em>
        </span>
      </div>
      <p className="ide-diff-summary">{diff.changeSummary}</p>
      {expanded && (
        <pre className="ide-diff-body">
          {lines.map((line, index) => (
            <span
              key={index}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'add'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'del'
                    : undefined
              }
            >
              {line || '\n'}
            </span>
          ))}
        </pre>
      )}
      {diff.approvalId && !diff.resolved ? (
        <div className="ide-diff-actions">
          <button className="ide-diff-reject" onClick={() => onRespond(diff, false)}>
            Reject
          </button>
          <button className="ide-diff-accept" onClick={() => onRespond(diff, true)}>
            Accept
          </button>
        </div>
      ) : (
        diff.resolved && (
          <span className={`ide-diff-resolved ${diff.resolved}`}>
            {diff.resolved === 'accepted' ? 'Accepted ✓' : 'Rejected'}
          </span>
        )
      )}
    </div>
  )
}
