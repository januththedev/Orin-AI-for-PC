// Bridge: provider commands — see docs/BRIDGE.md §AI providers.
use super::presets;
use super::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize, Clone)]
pub struct MessagePart {
    #[serde(rename = "type")]
    pub kind: String, // "text" | "image"
    #[serde(default)]
    pub text: String,
    #[serde(default, rename = "mediaType")]
    pub media_type: String,
    #[serde(default)]
    pub base64: String,
}

#[derive(Deserialize, Clone)]
pub struct AiMessage {
    pub role: String,
    pub parts: Vec<MessagePart>,
}

#[derive(Deserialize)]
pub struct AiSendRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<AiMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub tier: String,
    pub speed: u8,
    pub intelligence: u8,
    #[serde(rename = "contextTokens")]
    pub context_tokens: u32,
}

#[tauri::command]
pub async fn ai_send(req: AiSendRequest, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let request_id = req.request_id.clone();
    let abort = state.register_flag(&request_id);

    let app_handle = app.clone();
    let id_for_task = request_id.clone();
    let model_id = req.model_id.clone();
    let system = req.system.clone();
    let messages = req.messages.clone();
    let flag = abort.clone();
    let openai_base = super::store::read_setting(&state, "openai_compat/baseUrl");
    tauri::async_runtime::spawn(async move {
        let result = super::ai_impl::generate(
            &app_handle,
            &id_for_task,
            &model_id,
            &system,
            &messages,
            flag,
            openai_base,
        )
        .await;
        match result {
            Ok(text) => {
                let _ = app_handle.emit("ai-done", serde_json::json!({
                    "requestId": id_for_task,
                    "message": { "text": text, "stopReason": "end" },
                }));
            }
            Err(error) if error == "aborted" => {
                let _ = app_handle.emit("ai-done", serde_json::json!({
                    "requestId": id_for_task,
                    "message": { "text": "", "stopReason": "aborted" },
                }));
            }
            Err(error) => {
                let _ = app_handle.emit("ai-error", serde_json::json!({ "requestId": id_for_task, "error": error }));
            }
        }
    });
    Ok(request_id)
}

#[tauri::command]
pub fn ai_abort(request_id: String, state: State<'_, AppState>) {
    state.trip_flag(&request_id);
}

#[tauri::command]
pub fn models_list(state: State<'_, AppState>) -> Vec<ModelInfo> {
    super::ai_impl::catalog(super::auth::has_session(&state))
}

fn keyring_entry(provider: &str) -> Result<keyring::Entry, String> {
    // Service name stays "orin-ai" for backward compat so existing users keep
    // their stored keys after the app rename to Orin Code.
    keyring::Entry::new("orin-ai", provider).map_err(|e| e.to_string())
}

/// Read a stored provider key (used by dynamic model fetching).
pub fn keyring_read(provider: &str) -> Option<String> {
    keyring_entry(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

#[tauri::command]
pub fn providers_list() -> Vec<serde_json::Value> {
    presets::PRESETS
        .iter()
        .map(|preset| {
            serde_json::json!({
                "id": preset.id,
                "label": preset.label,
                "baseUrl": preset.base_url,
                "keyRequired": preset.key_required,
                "docsUrl": preset.docs_url,
                "hasKey": keyring_read(preset.id).is_some(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn models_fetch(
    preset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ModelInfo>, String> {
    super::models_fetch::fetch_for_preset(&state, &preset_id).await
}

/// Stealth check for the full-screen announcement: new free models since the
/// last check (baseline established silently on first run per preset).
#[tauri::command]
pub async fn models_check_new(
    preset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ModelInfo>, String> {
    super::models_fetch::check_new(&state, &preset_id).await
}

#[tauri::command]
pub fn provider_set_key(provider: String, key: String) -> Result<(), String> {
    keyring_entry(&presets::keyring_user(&provider))?.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn provider_has_key(provider: String) -> Result<bool, String> {
    match keyring_entry(&presets::keyring_user(&provider))?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
