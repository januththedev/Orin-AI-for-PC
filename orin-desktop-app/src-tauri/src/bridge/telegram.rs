// Bridge: Telegram bot notifications (Bot API, no extra crates).
//
// SECURITY: the bot token is NEVER in source, logs, or errors. It resolves
// at runtime from `ORIN_TELEGRAM_BOT_TOKEN` first, else the OS keyring slot
// `telegram-bot-token` (set once via `telegram_set_token` from Settings).
// Error strings never echo the token — only its presence/absence.
use tauri::State;

use super::AppState;

const KEYRING_SLOT: &str = "telegram-bot-token";
/// Bot API hard limit per message (closer to 4096; keep margin).
const MAX_TEXT_CHARS: usize = 4000;

fn bot_token() -> Option<String> {
    if let Ok(token) = std::env::var("ORIN_TELEGRAM_BOT_TOKEN") {
        if !token.trim().is_empty() {
            return Some(token.trim().to_string());
        }
    }
    keyring::Entry::new("orin-ai", KEYRING_SLOT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|token| !token.trim().is_empty())
}

/// Store the bot token in the OS keyring. Use this instead of env files when
/// the machine is shared; the value never touches the workspace or SQLite.
#[tauri::command]
pub fn telegram_set_token(token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Paste the bot token first.".into());
    }
    // Minimal shape check without leaking anything on failure.
    if !token.contains(':') {
        return Err("That doesn't look like a Bot API token.".into());
    }
    keyring::Entry::new("orin-ai", KEYRING_SLOT)
        .map_err(|e| e.to_string())?
        .set_password(token.trim())
        .map_err(|e| e.to_string())
}

/// True when a token is available via env or keyring. Never reveals it.
#[tauri::command]
pub fn telegram_has_token() -> bool {
    bot_token().is_some()
}

/// Send `text` to `chat_id` via `sendMessage`. Truncates overlong input;
/// reports reachability/API failures without ever including the token.
#[tauri::command]
pub async fn telegram_notify(
    chat_id: String,
    text: String,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let token = bot_token().ok_or(
        "No Telegram bot token configured. Set ORIN_TELEGRAM_BOT_TOKEN or save one in Settings → Models → Telegram.",
    )?;
    if chat_id.trim().is_empty() {
        return Err("Enter the destination chat id first.".into());
    }
    let mut message = text.trim().to_string();
    if message.is_empty() {
        return Err("Nothing to send.".into());
    }
    if message.chars().count() > MAX_TEXT_CHARS {
        let mut end = MAX_TEXT_CHARS;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&serde_json::json!({ "chat_id": chat_id.trim(), "text": message }))
        .send()
        .await
        .map_err(|_| "Could not reach Telegram. Check the connection and try again.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Telegram returned HTTP {}.", response.status().as_u16()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_keeps_char_boundary() {
        let mut message = "é".repeat(5000);
        assert!(message.chars().count() > super::MAX_TEXT_CHARS);
        let mut end = super::MAX_TEXT_CHARS;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        assert!(message.chars().count() <= super::MAX_TEXT_CHARS);
    }

    #[test]
    fn poll_parses_camel_case_decisions() {
        let body = serde_json::json!({
            "decisions": [
                { "approvalId": "a1", "approved": true },
                { "approvalId": "b2", "approved": false },
            ]
        });
        let decisions = parse_decisions(&body);
        assert_eq!(match_decision(&decisions, "a1"), Some(true));
        assert_eq!(match_decision(&decisions, "b2"), Some(false));
        assert_eq!(match_decision(&decisions, "nope"), None);
        assert!(parse_decisions(&serde_json::json!({})).is_empty());
    }
}

// ---------------------------------------------------------------------------
// Phone link: pair this PC with the user's Telegram so agent approvals can
// be answered from the phone (Orin Code bot Approve/Deny buttons).
// Backend: POST {api_base}/api/pc-link (see BACKEND-CONTRACT.md).
// ---------------------------------------------------------------------------

fn api_base() -> String {
    std::env::var("ORIN_API_BASE").unwrap_or_else(|_| "https://orinai.org".to_string())
}

/// Live phone-mirror context for one agent run. Built once at run start;
/// dropped (mirror off) the moment the backend says the phone isn't linked.
#[derive(Clone)]
pub struct PhoneMirror {
    pub api_base: String,
    pub token: String,
}

async fn authed(api_base: &str, token: &str, action: &str, extra: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut body = serde_json::Map::new();
    body.insert("action".to_string(), serde_json::Value::String(action.to_string()));
    if let serde_json::Value::Object(map) = extra {
        body.extend(map);
    }
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{api_base}/api/pc-link"))
        .bearer_auth(token)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|_| "Could not reach orinai.org.".to_string())?;
    let status = response.status().as_u16();
    let value: serde_json::Value = response.json().await.unwrap_or(serde_json::json!({}));
    if status == 401 {
        return Err("session expired".into());
    }
    if status == 404 {
        return Err("phone not linked".into());
    }
    if !(200..300).contains(&status) {
        return Err(value["error"].as_str().unwrap_or("pc-link failed").to_string());
    }
    Ok(value)
}

/// Parse `GET`-style poll bodies: `{ decisions: [{ approvalId, approved }] }`.
fn parse_decisions(body: &serde_json::Value) -> Vec<(String, bool)> {
    body["decisions"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|d| {
                    Some((
                        d.get("approvalId")?.as_str()?.to_string(),
                        d.get("approved")?.as_bool()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn match_decision(decisions: &[(String, bool)], id: &str) -> Option<bool> {
    decisions.iter().find(|(aid, _)| aid == id).map(|(_, approved)| *approved)
}

/// Best-effort push of one approval to the linked phone. Returns false when
/// mirroring should be switched off for the rest of the run.
pub async fn mirror_push(
    mirror: &PhoneMirror,
    approval_id: &str,
    tool: &str,
    title: &str,
    detail: &str,
) -> bool {
    authed(
        &mirror.api_base,
        &mirror.token,
        "push",
        serde_json::json!({
            "approvalId": approval_id,
            "tool": tool,
            "title": title.chars().take(200).collect::<String>(),
            "detail": detail.chars().take(1000).collect::<String>(),
        }),
    )
    .await
    .is_ok()
}

/// Poll consumed phone decisions. Errors are swallowed (local UI stays king).
pub async fn mirror_poll(mirror: &PhoneMirror) -> Vec<(String, bool)> {
    authed(&mirror.api_base, &mirror.token, "poll", serde_json::json!({}))
        .await
        .map(|body| parse_decisions(&body))
        .unwrap_or_default()
}

/// Find one run's decision in a poll batch. Used by the agent approval gate.
pub fn mirror_match(decisions: &[(String, bool)], id: &str) -> Option<bool> {
    match_decision(decisions, id)
}

/// Try to establish mirroring for an agent run: needs a live session AND a
/// linked phone. Returns None (local-only) on any failure — never blocks.
pub async fn mirror_for_run(state: &AppState) -> Option<PhoneMirror> {
    let token = super::auth::ensure_id_token(state).await.ok()?;
    let api_base = api_base();
    let linked = authed(&api_base, &token, "status", serde_json::json!({}))
        .await
        .ok()?
        .get("linked")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !linked {
        return None;
    }
    Some(PhoneMirror { api_base, token })
}

/// Pairing code for Settings → Notifications ("Link phone").
#[tauri::command]
pub async fn pc_link_start(state: State<'_, AppState>) -> Result<String, String> {
    let token = super::auth::ensure_id_token(state.inner())
        .await
        .map_err(|_| "Sign in to Settings → Account first.".to_string())?;
    let reply = authed(&api_base(), &token, "start", serde_json::json!({})).await?;
    reply["code"].as_str().map(str::to_string).ok_or("No pairing code returned.".into())
}

#[tauri::command]
pub async fn pc_link_status(state: State<'_, AppState>) -> Result<bool, String> {
    let token = super::auth::ensure_id_token(state.inner())
        .await
        .map_err(|_| "Sign in to Settings → Account first.".to_string())?;
    let reply = authed(&api_base(), &token, "status", serde_json::json!({})).await?;
    Ok(reply.get("linked").and_then(|v| v.as_bool()).unwrap_or(false))
}

#[tauri::command]
pub async fn pc_link_unlink(state: State<'_, AppState>) -> Result<(), String> {
    let token = super::auth::ensure_id_token(state.inner())
        .await
        .map_err(|_| "Sign in to Settings → Account first.".to_string())?;
    authed(&api_base(), &token, "unlink", serde_json::json!({})).await?;
    Ok(())
}
