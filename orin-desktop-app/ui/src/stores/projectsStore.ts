import { create } from 'zustand'
import { bridge } from '../bridge/client'

export type KnowledgeStatus = 'ready' | 'processing'

export interface KnowledgeFile {
  id: string
  name: string
  type: string
  sizeBytes: number
  addedAt: string
  status: KnowledgeStatus
}

export interface Project {
  id: string
  name: string
  rootPath: string
  description: string
  customInstructions: string
  /** Brand contract for Studio/design work (DESIGN.md contents). Fed to the agent. */
  designSystem: string
  knowledge: KnowledgeFile[]
  createdAt: string
  updatedAt: string
}

interface ProjectsState {
  projects: Project[]
  activeProjectId: string | null
  hydrated: boolean
  hydrate: () => Promise<void>
  createProject: (name?: string) => Project
  openFromFolder: () => Promise<Project | null>
  update: (id: string, patch: Partial<Omit<Project, 'id'>>) => void
  remove: (id: string) => void
  addKnowledge: (projectId: string, files: File[]) => void
  removeKnowledge: (projectId: string, knowledgeId: string) => void
}

const PROJECTS_KEY = 'projects'
let saveTimer: ReturnType<typeof setTimeout> | undefined

// Debounced persist of the whole projects doc (projects + active pointer).
function persistProjects(state: ProjectsState) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    bridge
      .storeSet(PROJECTS_KEY, { projects: state.projects, activeProjectId: state.activeProjectId })
      .catch(() => {})
  }, 350)
}

const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()

function touch(project: Project): Project {
  return { ...project, updatedAt: now() }
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    try {
      const saved = await bridge.storeGet<{ projects?: Project[]; activeProjectId?: string | null }>(PROJECTS_KEY)
      if (saved && typeof saved === 'object') {
        // Forward-fill fields added after some installs (e.g. designSystem).
        const projects = Array.isArray(saved.projects)
          ? saved.projects.map((p) => ({ ...p, designSystem: p.designSystem ?? '' }))
          : []
        set({
          projects,
          activeProjectId: saved.activeProjectId ?? null,
          hydrated: true,
        })
        return
      }
    } catch {
      // First launch or storage unavailable — defaults are fine.
    }
    set({ hydrated: true })
  },

  createProject: (name) => {
    const project: Project = {
      id: uid(),
      name: name?.trim() || 'Untitled project',
      rootPath: '',
      description: '',
      customInstructions: '',
      designSystem: '',
      knowledge: [],
      createdAt: now(),
      updatedAt: now(),
    }
    set((state) => ({ projects: [project, ...state.projects], activeProjectId: project.id }))
    return project
  },

  openFromFolder: async () => {
    const pick = await bridge.pickFolder()
    if (!pick) return null
    // Verify we can actually read the folder before registering it.
    await bridge.readDir(pick.path, 2)
    const project: Project = {
      id: uid(),
      name: pick.name || pick.path.split(/[\\/]/).filter(Boolean).at(-1) || 'Imported folder',
      rootPath: pick.path,
      description: '',
      customInstructions: '',
      designSystem: '',
      knowledge: [],
      createdAt: now(),
      updatedAt: now(),
    }
    set((state) => ({ projects: [project, ...state.projects], activeProjectId: project.id }))
    return project
  },

  update: (id, patch) => {
    set((state) => ({
      projects: state.projects.map((project) => (project.id === id ? touch({ ...project, ...patch }) : project)),
    }))
  },

  remove: (id) =>
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== id),
      activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
    })),

  addKnowledge: (projectId, files) => {
    const entries: KnowledgeFile[] = files.map((file) => ({
      id: uid(),
      name: file.name,
      type: file.type || file.name.split('.').at(-1) || 'file',
      sizeBytes: file.size,
      addedAt: now(),
      status: 'ready' as const,
    }))
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId
          ? touch({ ...project, knowledge: [...project.knowledge, ...entries] })
          : project,
      ),
    }))
  },

  removeKnowledge: (projectId, knowledgeId) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId
          ? touch({ ...project, knowledge: project.knowledge.filter((entry) => entry.id !== knowledgeId) })
          : project,
      ),
    })),
}))

// Re-save whenever anything persisted changes.
useProjectsStore.subscribe((state, prev) => {
  if (state.projects !== prev.projects || state.activeProjectId !== prev.activeProjectId) {
    persistProjects(useProjectsStore.getState())
  }
})

export function selectActiveProject(state: ProjectsState): Project | null {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null
}
