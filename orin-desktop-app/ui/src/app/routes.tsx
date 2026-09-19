import { lazy, Suspense } from 'react'
import type { ViewId } from '../stores/uiStore'

// Every view is code-split; feature agents own these modules.
const HomePage = lazy(() => import('../features/home/HomePage'))
const ChatPage = lazy(() => import('../features/chat/ChatPage'))
const ProjectsPage = lazy(() => import('../features/projects/ProjectsPage'))
const ArtifactsPage = lazy(() => import('../features/artifacts/ArtifactsPage'))
const IdePage = lazy(() => import('../features/ide/IdePage'))
const ComputerUsePage = lazy(() => import('../features/computer/ComputerUsePage'))
const CustomizePage = lazy(() => import('../features/settings/CustomizePage'))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage'))
const SkillsPage = lazy(() => import('../features/settings/SkillsPage'))
const ConnectorsPage = lazy(() => import('../features/settings/ConnectorsPage'))
const StudioPage = lazy(() => import('../features/studio/StudioPage'))

export function CurrentView({ view }: { view: ViewId }) {
  switch (view) {
    case 'chat':
      return <ChatPage />
    case 'projects':
      return <ProjectsPage />
    case 'artifacts':
      return <ArtifactsPage />
    case 'studio':
      return <StudioPage />
    case 'ide':
      return <IdePage />
    case 'computer':
      return <ComputerUsePage />
    case 'customize':
      return <CustomizePage />
    case 'settings':
      return <SettingsPage />
    case 'skills':
      return <SkillsPage />
    case 'connectors':
      return <ConnectorsPage />
    case 'home':
    default:
      return <HomePage />
  }
}

export function ViewFallback() {
  return (
    <div className="view-fallback">
      <div className="skeleton-block" />
    </div>
  )
}

export const viewComponents = {
  HomePage,
  ChatPage,
  ProjectsPage,
  ArtifactsPage,
  StudioPage,
  IdePage,
  ComputerUsePage,
  CustomizePage,
  SettingsPage,
  SkillsPage,
  ConnectorsPage,
}
