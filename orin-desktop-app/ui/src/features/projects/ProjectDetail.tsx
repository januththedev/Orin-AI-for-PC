import { useEffect, useRef } from 'react'
import {
  FileAudio2,
  FileImage,
  FileText,
  FileVideo2,
  MessageSquare,
  Paperclip,
  Trash2,
} from 'lucide-react'
import type { KnowledgeFile, Project } from '../../stores/projectsStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useChatsStore } from '../../stores/chatsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../../components/EmptyState'
import { timeAgo } from './timeAgo'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function knowledgeIcon(type: string) {
  const t = type.toLowerCase()
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(t)) return FileImage
  if (t.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(t)) return FileVideo2
  if (t.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(t)) return FileAudio2
  if (t.includes('pdf') || t.startsWith('text/') || ['md', 'txt', 'doc', 'docx', 'csv'].includes(t)) return FileText
  return Paperclip
}

export function ProjectDetail({ project, onBack }: { project: Project; onBack: () => void }) {
  const update = useProjectsStore((state) => state.update)
  const remove = useProjectsStore((state) => state.remove)
  const addKnowledge = useProjectsStore((state) => state.addKnowledge)
  const removeKnowledge = useProjectsStore((state) => state.removeKnowledge)

  const fileInputRef = useRef<HTMLInputElement>(null)
  // Two-step destructive confirmation (window.confirm is unavailable in the webview).
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => () => clearTimeout(confirmTimer.current), [])

  const armRemove = () => {
    const button = confirmRef.current
    if (!button) return
    if (button.dataset.armed === '1') {
      remove(project.id)
      onBack()
      return
    }
    button.dataset.armed = '1'
    button.classList.add('danger-armed')
    button.textContent = 'Click again to remove'
    confirmTimer.current = setTimeout(() => {
      if (!confirmRef.current) return
      confirmRef.current.dataset.armed = ''
      confirmRef.current.classList.remove('danger-armed')
      confirmRef.current.textContent = 'Remove project'
    }, 3000)
  }

  return (
    <div className="projects-page">
      <header className="page-header project-detail-header">
        <div>
          <button className="back-button" onClick={onBack}>
            <span aria-hidden>←</span> All projects
          </button>
          <h1 className="page-title">{project.name}</h1>
          <p className="project-root-path mono">{project.rootPath || 'No folder linked yet'}</p>
        </div>
      </header>

      <div className="project-detail">
        {/* ------------------------------------------------------- overview */}
        <section className="detail-section">
          <h2 className="section-title">Overview</h2>
          <div className="overview-grid">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="field-input"
                defaultValue={project.name}
                onBlur={(event) => {
                  const name = event.target.value.trim()
                  if (name && name !== project.name) update(project.id, { name })
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Description</span>
              <input
                className="field-input"
                placeholder="What is this project about?"
                defaultValue={project.description}
                onBlur={(event) => {
                  if (event.target.value !== project.description) update(project.id, { description: event.target.value })
                }}
              />
            </label>
            <label className="field field-wide">
              <span className="field-label">Custom instructions</span>
              <textarea
                className="field-textarea"
                rows={4}
                placeholder="Standing guidance the AI should follow while working on this project…"
                defaultValue={project.customInstructions}
                onBlur={(event) => {
                  if (event.target.value !== project.customInstructions)
                    update(project.id, { customInstructions: event.target.value })
                }}
              />
            </label>
            <label className="field field-wide">
              <span className="field-label">Design system (DESIGN.md)</span>
              <textarea
                className="field-textarea"
                rows={6}
                placeholder="Brand contract for Studio work — palette hex codes, fonts, component rules. The agent reads this on every run…"
                defaultValue={project.designSystem}
                onBlur={(event) => {
                  if (event.target.value !== (project.designSystem ?? ''))
                    update(project.id, { designSystem: event.target.value })
                }}
              />
            </label>
          </div>
        </section>

        {/* ------------------------------------------------------ knowledge */}
        <section className="detail-section">
          <div className="section-head">
            <h2 className="section-title">Knowledge</h2>
            <button className="button-secondary" onClick={() => fileInputRef.current?.click()}>
              Add files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                if (files.length) addKnowledge(project.id, files)
                event.target.value = ''
              }}
            />
          </div>
          {project.knowledge.length === 0 ? (
            <EmptyState title="Upload files to give your AI additional context." />
          ) : (
            <table className="knowledge-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Added</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {project.knowledge.map((entry: KnowledgeFile) => {
                  const Icon = knowledgeIcon(entry.type)
                  return (
                    <tr key={entry.id}>
                      <td className="knowledge-name">
                        <Icon size={14} /> <span>{entry.name}</span>
                      </td>
                      <td className="muted-cell">{entry.type}</td>
                      <td className="muted-cell">{formatSize(entry.sizeBytes)}</td>
                      <td className="muted-cell">{timeAgo(entry.addedAt)}</td>
                      <td>
                        <span className={`status-chip status-${entry.status}`}>{entry.status}</span>
                      </td>
                      <td className="row-actions">
                        <button
                          className="icon-ghost"
                          aria-label={`Remove ${entry.name}`}
                          onClick={() => removeKnowledge(project.id, entry.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* ---------------------------------------------------------- chats */}
        <ProjectChatsSection projectId={project.id} />

        {/* ---------------------------------------------------- danger zone */}
        <section className="detail-section danger-zone">
          <h2 className="section-title">Danger zone</h2>
          <p className="danger-hint">
            Removes this project from Orin. Files on disk and conversations are not deleted.
          </p>
          <button ref={confirmRef} className="button-danger" onClick={armRemove}>
            Remove project
          </button>
        </section>
      </div>
    </div>
  )
}

function ProjectChatsSection({ projectId }: { projectId: string }) {
  const conversations = useChatsStore((state) => state.conversations)
  const selectChat = useChatsStore((state) => state.selectChat)
  const setView = useUiStore((state) => state.setView)
  const chats = conversations.filter((chat) => chat.projectId === projectId)

  if (chats.length === 0) {
    return (
      <section className="detail-section">
        <h2 className="section-title">Chats</h2>
        <p className="empty-inline">No conversations in this project yet.</p>
      </section>
    )
  }

  return (
    <section className="detail-section">
      <h2 className="section-title">Chats</h2>
      <ul className="project-chat-list">
        {chats.map((chat) => (
          <li key={chat.id}>
            <button
              className="project-chat-row"
              onClick={() => {
                selectChat(chat.id)
                setView('chat')
              }}
            >
              <MessageSquare size={14} />
              <span className="project-chat-title">{chat.title}</span>
              <span className="project-chat-meta">{timeAgo(chat.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
