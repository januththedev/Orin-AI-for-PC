// Bridge: per-user settings/chat sync via the backend /api/desktop-sync
// endpoint (last-write-wins, ≤512 KB per user). See docs/BRIDGE.md §Sync.
use super::auth;
use super::AppState;
use serde_json::Value;
use tauri::State;

const MAX_BYTES: usize = 512 * 1024;

#[tauri::command]
pub async fn sync_pull(state: State<'_, AppState>) -> Result<Value, String> {
    let token = auth::ensure_id_token(state.inner())
        .await
        .map_err(|_| "signed-out".to_string())?;
    let response = auth::backend_client(30)?
        .get(format!("{}/api/desktop-sync", auth::api_base()))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Sync network error: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Sync failed ({})", response.status()));
    }
    Ok(response.json::<Value>().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn sync_push(
    blob: Value,
    schema_version: Option<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let serialized = serde_json::to_string(&blob).map_err(|e| e.to_string())?;
    if serialized.len() > MAX_BYTES {
        return Err(format!("Sync payload too large ({} bytes)", serialized.len()));
    }
    let token = auth::ensure_id_token(state.inner())
        .await
        .map_err(|_| "signed-out".to_string())?;
    let response = auth::backend_client(30)?
        .put(format!("{}/api/desktop-sync", auth::api_base()))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "blob": blob,
            "schemaVersion": schema_version.unwrap_or(1),
        }))
        .send()
        .await
        .map_err(|error| format!("Sync network error: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Sync push failed ({})", response.status()));
    }
    Ok(())
}
