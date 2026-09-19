// Cross-device sync of settings + chats via the Rust bridge's sync commands.
// Whole-snapshot, last-write-wins v1: remote wins on pull, local pushes are
// debounced 30 s. Everything here is best-effort — offline/signed-out simply
// keeps local state authoritative.
import { bridge } from '../bridge/client'
import { useSettingsStore } from './settingsStore'
import { useChatsStore, withMessages, settlePending } from './chatsStore'

function buildPayload() {
  const s = useSettingsStore.getState()
  return {
    schemaVersion: 1,
    blob: {
      settings: {
        theme: s.theme,
        accent: s.accent,
        density: s.density,
        fontSize: s.fontSize,
        codeFont: s.codeFont,
        defaultModelId: s.defaultModelId,
        defaultMode: s.defaultMode,
        cloudSync: s.cloudSync,
      },
      chats: withMessages(useChatsStore.getState().conversations),
    },
  }
}

let pushTimer: ReturnType<typeof setTimeout> | undefined
export function scheduleCloudSync() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(async () => {
    try {
      if (!useSettingsStore.getState().cloudSync) return
      const { signedIn } = await bridge.authStatus()
      if (!signedIn) return
      const payload = buildPayload()
      await bridge.syncPush(payload.blob, payload.schemaVersion)
    } catch {
      // best-effort — local state remains authoritative until the next push
    }
  }, 30_000)
}

// Remote wins v1. Called from settingsStore.hydrate after the local load.
export async function pullAndMerge() {
  if (!useSettingsStore.getState().cloudSync) return
  const { signedIn } = await bridge.authStatus()
  if (!signedIn) return
  type SyncedSettings = Partial<ReturnType<typeof useSettingsStore.getState>>
  const remote = await bridge.syncPull<{ settings?: SyncedSettings; chats?: unknown }>()
  if (!remote?.blob) return
  if (remote.blob.settings) useSettingsStore.setState(remote.blob.settings)
  if (Array.isArray(remote.blob.chats) && remote.blob.chats.length > 0) {
    const kept = settlePending(
      withMessages(remote.blob.chats as ReturnType<typeof useChatsStore.getState>['conversations']),
    )
    if (kept.length > 0) {
      useChatsStore.setState({ conversations: kept })
    }
  }
}
