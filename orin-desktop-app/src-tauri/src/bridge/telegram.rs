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
}
