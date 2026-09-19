import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { X } from 'lucide-react'
import { bridge } from '../../bridge/client'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { FileExplorer } from './FileExplorer'
import { TerminalPane } from './TerminalPane'
import { AiPanel } from './AiPanel'
import './ide.css'

const LANGUAGES: Array<[RegExp, string]> = [
  [/\.(ts|tsx|mts|cts)$/i, 'typescript'],
  [/\.(js|jsx|mjs|cjs)$/i, 'javascript'],
  [/\.(py|pyw)$/i, 'python'],
  [/\.rs$/i, 'rust'],
  [/\.go$/i, 'go'],
  [/\.java$/i, 'java'],
  [/\.kt$/i, 'kotlin'],
  [/\.c$/i, 'c'],
  [/\.(cpp|cc|cxx|h|hpp|hh)$/i, 'cpp'],
  [/\.cs$/i, 'csharp'],
  [/\.swift$/i, 'swift'],
  [/\.rb$/i, 'ruby'],
  [/\.php$/i, 'php'],
  [/\.sql$/i, 'sql'],
  [/\.lua$/i, 'lua'],
  [/\.(xml|xsl|svg|plist|csproj)$/i, 'xml'],
  [/\.(vue|svelte|astro)$/i, 'html'],
  [/\.json$/i, 'json'],
  [/\.(css|scss|less)$/i, 'css'],
  [/\.(html?|htm)$/i, 'html'],
  [/\.(md|markdown)$/i, 'markdown'],
  [/\.(sh|bash|zsh|ps1)$/i, 'shell'],
  [/\.(yml|yaml)$/i, 'yaml'],
  [/\.(toml|ini|cfg|conf)$/i, 'ini'],
  [/dockerfile[^.]*$/i, 'dockerfile'],
  [/\.git(ignore|attributes|modules)$/i, 'ini'],
]

function languageFor(name: string): string {
  return LANGUAGES.find(([pattern]) => pattern.test(name))?.[1] ?? 'plaintext'
}

interface OpenTab {
  path: string
  name: string
  content: string
  dirty: boolean
  error?: string
}

export default function IdePage() {
  const projects = useProjectsStore((state) => state.projects)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const toast = useUiStore((state) => state.toast)

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  )
  const root = project?.rootPath ?? null

  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)

  const openFile = async (path: string, name: string) => {
    const existing = tabs.find((tab) => tab.path === path)
    if (existing) {
      setActivePath(path)
      return
    }
    try {
      const content = await bridge.readFile(path)
      const tab: OpenTab = { path, name, content, dirty: false }
      setTabs((prev) => [...prev, tab])
      setActivePath(path)
    } catch (error) {
      const tab: OpenTab = {
        path,
        name,
        content: '',
        dirty: false,
        error: String(error).replace(/^Error:\s*/, ''),
      }
      setTabs((prev) => [...prev, tab])
      setActivePath(path)
    }
  }

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null

  const closeTab = (path: string) => {
    setTabs((prev) => prev.filter((tab) => tab.path !== path))
    if (activePath === path) {
      const remaining = tabs.filter((tab) => tab.path !== path)
      setActivePath(remaining.at(-1)?.path ?? null)
    }
  }

  const saveActive = async () => {
    if (!activeTab || activeTab.error) return
    try {
      await bridge.writeFile(activeTab.path, activeTab.content)
      setTabs((prev) => prev.map((tab) => (tab.path === activeTab.path ? { ...tab, dirty: false } : tab)))
      toast('success', 'Saved', activeTab.name)
    } catch (error) {
      toast('error', 'Could not save', String(error))
    }
  }

  // Ctrl+S saves the active editor tab.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (!activeTab) return
        event.preventDefault()
        saveActive()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  return (
    <div className="ide-page">
      <aside className="ide-left">
        <div className="ide-pane-title">Explorer{project ? ` · ${project.name}` : ''}</div>
        <FileExplorer root={root} onOpenFile={openFile} />
      </aside>

      <section className="ide-center">
        <div className="ide-tabbar">
          {tabs.length === 0 && <span className="ide-tabbar-empty">No files open</span>}
          {tabs.map((tab) => (
            <span
              key={tab.path}
              className={`ide-tab ${tab.path === activePath ? 'active' : ''}`}
              onClick={() => setActivePath(tab.path)}
              onMouseDown={(event) => {
                if (event.button === 1) closeTab(tab.path)
              }}
            >
              {tab.dirty && <i className="ide-dirty-dot" />}
              <span className="ide-tab-name">{tab.name}</span>
              <button
                className="ide-tab-close"
                aria-label={`Close ${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.path)
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>

        <div className="ide-editor">
          {!activeTab && (
            <div className="ide-editor-empty">
              <p>Select a file from the explorer</p>
              <span>Orin's proposed changes will also appear here.</span>
            </div>
          )}
          {activeTab?.error && (
            <div className="ide-editor-notice">
              <strong>{activeTab.name}</strong>
              <p>{activeTab.error}</p>
            </div>
          )}
          {activeTab && !activeTab.error && (
            <Editor
              height="100%"
              language={languageFor(activeTab.name)}
              theme="vs-dark"
              value={activeTab.content}
              onChange={(value) =>
                setTabs((prev) =>
                  prev.map((tab) =>
                    tab.path === activeTab.path ? { ...tab, content: value ?? '', dirty: true } : tab,
                  ),
                )
              }
              options={{
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                minimap: { enabled: true },
                smoothScrolling: true,
                scrollBeyondLastLine: false,
                padding: { top: 14, bottom: 14 },
                automaticLayout: true,
                renderLineHighlight: 'all',
                cursorBlinking: 'smooth',
              }}
            />
          )}
        </div>

        <TerminalPane root={root} />
      </section>

      <aside className="ide-right">
        <AiPanel root={root} />
      </aside>
    </div>
  )
}
