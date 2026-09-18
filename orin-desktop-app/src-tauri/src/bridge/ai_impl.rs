// Provider implementations behind `ai_send`. Every stream chunk must carry the
// requestId from the original request so the renderer can correlate events.
use super::ai::{AiMessage, MessagePart, ModelInfo};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Chunk emitter shared by all providers. A generic `impl Fn` bound keeps the
/// streaming futures `Send` (a `&dyn Fn` parameter would not be).
type StreamResult = Result<String, String>;

pub async fn generate(
    app: &AppHandle,
    request_id: &str,
    model_id: &str,
    system: &Option<String>,
    messages: &[AiMessage],
    abort: Arc<AtomicBool>,
    openai_base_url: Option<String>,
) -> Result<String, String> {
    let emit_chunk = |delta: &str| {
        let _ = app.emit(
            "ai-chunk",
            serde_json::json!({ "requestId": request_id, "delta": delta }),
        );
    };
    match model_id.split('/').next().unwrap_or("mock") {
        "anthropic" => anthropic::stream(model_id, system, messages, abort, &emit_chunk).await,
        "mock" => mock::stream(messages, abort, &emit_chunk).await,
        "orin" => orin_cloud::stream(app, request_id, system, messages, abort).await,
        preset => {
            openai_compat::stream(
                preset,
                model_id,
                openai_base_url,
                system,
                messages,
                abort,
                &emit_chunk,
            )
            .await
        }
    }
}

fn last_user_text(messages: &[AiMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| {
            m.parts
                .iter()
                .filter(|p| p.kind == "text")
                .map(|p| p.text.as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

pub fn catalog(signed_in: bool) -> Vec<ModelInfo> {
    let mut models = vec![
        ModelInfo { id: "mock/orin-offline".into(), provider: "mock".into(), label: "Orin Offline".into(), tier: "balanced".into(), speed: 3, intelligence: 1, context_tokens: 32_000 },
        ModelInfo { id: "anthropic/claude-sonnet-4-5".into(), provider: "anthropic".into(), label: "Claude Sonnet 4.5".into(), tier: "balanced".into(), speed: 2, intelligence: 3, context_tokens: 200_000 },
        ModelInfo { id: "anthropic/claude-haiku-4".into(), provider: "anthropic".into(), label: "Claude Haiku 4".into(), tier: "fast".into(), speed: 3, intelligence: 2, context_tokens: 200_000 },
        // Curated free picks — the full live catalog loads per provider via
        // models_fetch (OpenRouter alone exposes hundreds of :free models).
        ModelInfo { id: "openrouter/deepseek/deepseek-chat-v3-0324:free".into(), provider: "openrouter".into(), label: "DeepSeek V3 · Free".into(), tier: "reasoning".into(), speed: 2, intelligence: 3, context_tokens: 163_840 },
        ModelInfo { id: "openrouter/meta-llama/llama-3.3-70b-instruct:free".into(), provider: "openrouter".into(), label: "Llama 3.3 70B · Free".into(), tier: "balanced".into(), speed: 2, intelligence: 2, context_tokens: 65_536 },
        ModelInfo { id: "openrouter/google/gemma-3-27b-it:free".into(), provider: "openrouter".into(), label: "Gemma 3 27B · Free".into(), tier: "fast".into(), speed: 3, intelligence: 2, context_tokens: 96_000 },
        ModelInfo { id: "groq/llama-3.3-70b-versatile".into(), provider: "groq".into(), label: "Llama 3.3 70B (Groq)".into(), tier: "fast".into(), speed: 3, intelligence: 2, context_tokens: 131_072 },
        ModelInfo { id: "gemini/gemini-2.0-flash".into(), provider: "gemini".into(), label: "Gemini 2.0 Flash".into(), tier: "fast".into(), speed: 3, intelligence: 2, context_tokens: 1_048_576 },
    ];
    // Orin Cloud models appear only for signed-in users — they are metered by
    // the orinai.org plan server-side (no local key involved).
    if signed_in {
        models.push(ModelInfo { id: "orin/orin-pro".into(), provider: "orin_cloud".into(), label: "Orin Pro · Cloud".into(), tier: "balanced".into(), speed: 3, intelligence: 3, context_tokens: 128_000 });
        models.push(ModelInfo { id: "orin/orin-flash".into(), provider: "orin_cloud".into(), label: "Orin Flash · Cloud".into(), tier: "fast".into(), speed: 3, intelligence: 2, context_tokens: 128_000 });
    }
    models
}

/// Offline typewriter responder — proves the full event pipeline and keeps the
/// entire product demoable without any API keys.
pub mod mock {
    use super::*;

    pub async fn stream<E: Fn(&str) + Send + Sync>(
        messages: &[AiMessage],
        abort: Arc<AtomicBool>,
        emit_chunk: &E,
    ) -> StreamResult {
        let prompt = last_user_text(messages);
        let reply = format!(
            "Here's my take on “{}”.\n\nI'm the built-in offline responder — no API key is configured yet. Open **Settings → Models** to connect Anthropic or any OpenAI-compatible endpoint and I'll answer with a real model.\n\nMeanwhile the rest of this workspace is fully live: projects, artifacts, the editor, terminals, and Computer Use in the virtual desktop.",
            prompt
        );
        for word in reply.split_inclusive(' ') {
            if abort.load(Ordering::Relaxed) {
                return Err("aborted".into());
            }
            emit_chunk(word);
            tokio::time::sleep(std::time::Duration::from_millis(14)).await;
        }
        Ok(reply)
    }
}

pub mod anthropic {
    use super::*;
    use futures_util::StreamExt;

    const API_URL: &str = "https://api.anthropic.com/v1/messages";

    pub async fn stream<E: Fn(&str) + Send + Sync>(
        model_id: &str,
        system: &Option<String>,
        messages: &[AiMessage],
        abort: Arc<AtomicBool>,
        emit_chunk: &E,
    ) -> StreamResult {
        let key = keyring::Entry::new("orin-ai", "anthropic")
            .and_then(|entry| entry.get_password())
            .map_err(|_| "No Anthropic API key configured. Add one in Settings → Models.".to_string())?;
        let model = model_id.trim_start_matches("anthropic/");

        let body = serde_json::json!({
            "model": model,
            "max_tokens": 8192u32,
            "stream": true,
            "system": system.clone().unwrap_or_default(),
            "messages": messages.iter().map(|m| serde_json::json!({
                "role": m.role,
                "content": m.parts.iter().map(|p| if p.kind == "image" {
                    serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": p.media_type, "data": p.base64 } })
                } else {
                    serde_json::json!({ "type": "text", "text": p.text })
                }).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
        });

        let client = reqwest::Client::new();
        let response = client
            .post(API_URL)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Network error contacting Anthropic: {error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(friendly_api_error(status.as_u16(), &detail));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            if abort.load(Ordering::Relaxed) {
                return Err("aborted".into());
            }
            buffer.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer.drain(..=line_end);
                let Some(data) = line.strip_prefix("data: ") else { continue };
                let Ok(event) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                match event["type"].as_str() {
                    Some("content_block_delta") => {
                        if let Some(delta) = event["delta"]["text"].as_str() {
                            full.push_str(delta);
                            emit_chunk(delta);
                        }
                    }
                    Some("error") => {
                        return Err(event["error"]["message"].as_str().unwrap_or("Anthropic stream error").into())
                    }
                    _ => {}
                }
            }
        }
        Ok(full)
    }

    fn friendly_api_error(status: u16, detail: &str) -> String {
        match status {
            401 => "The Anthropic API key was rejected. Check it in Settings → Models.".into(),
            429 => "Rate limited by Anthropic. Wait a moment and try again.".into(),
            _ => format!("Anthropic API error {status}. {detail}"),
        }
    }
}

pub mod openai_compat {
    use super::*;
    use futures_util::StreamExt;

    /// Streaming chat-completions against any OpenAI-compatible endpoint.
    /// Base URL + key come from settings (`openai_compat/baseUrl`) and the OS
    /// credential manager (`orin-ai` / `openai_compat`), mirroring anthropic::stream
    /// with SSE lines shaped as `choices[0].delta.content`.
    pub async fn stream<E: Fn(&str) + Send + Sync>(
        preset_id: &str,
        model_id: &str,
        base_url: Option<String>,
        system: &Option<String>,
        messages: &[AiMessage],
        abort: Arc<AtomicBool>,
        emit_chunk: &E,
    ) -> StreamResult {
        let key_slot = crate::bridge::presets::keyring_user(preset_id);
        let key = keyring::Entry::new("orin-ai", &key_slot)
            .and_then(|entry| entry.get_password())
            .ok();
        let key_required = crate::bridge::presets::find(preset_id).map(|p| p.key_required).unwrap_or(true);
        if key.is_none() && key_required {
            let label = crate::bridge::presets::find(preset_id).map(|p| p.label).unwrap_or("This provider");
            return Err(format!("{label} needs an API key. Add one in Settings → Models."));
        }
        let base = crate::bridge::presets::resolve_base_url(preset_id, &base_url);
        // model_id is "<preset>/<model>" — everything after the first '/' is
        // the provider-side model name (e.g. "deepseek/deepseek-chat:free").
        let model = match model_id.split_once('/') {
            Some((_preset, rest)) if !rest.is_empty() => rest,
            _ => model_id,
        };

        let mut chat_messages =
            vec![serde_json::json!({ "role": "system", "content": system.clone().unwrap_or_default() })];
        for message in messages {
            let text = message
                .parts
                .iter()
                .filter(|part| part.kind == "text")
                .map(|part| part.text.clone())
                .collect::<Vec<_>>()
                .join("\n");
            chat_messages.push(serde_json::json!({ "role": message.role, "content": text }));
        }
        // OpenRouter etiquette headers; harmless elsewhere.
        let mut request = reqwest::Client::new()
            .post(format!("{base}/chat/completions"))
            .header("HTTP-Referer", "https://orin.ai")
            .header("X-Title", "Orin Code")
            .json(&serde_json::json!({ "model": model, "stream": true, "messages": chat_messages }));
        if let Some(key) = &key {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Network error contacting {preset_id}: {error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            let friendly = match status.as_u16() {
                401 => "was rejected (check the API key in Settings → Models)".to_string(),
                402 | 429 => "reported quota/credit limits for this key".to_string(),
                _ => format!("returned HTTP {status}"),
            };
            return Err(format!("{preset_id} {friendly}. {detail}"));
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            if abort.load(Ordering::Relaxed) {
                return Err("aborted".into());
            }
            buffer.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer.drain(..=line_end);
                let Some(data) = line.strip_prefix("data: ") else { continue };
                if data == "[DONE]" {
                    return Ok(full);
                }
                let Ok(event) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                if let Some(delta) = event["choices"][0]["delta"]["content"].as_str() {
                    full.push_str(delta);
                    emit_chunk(delta);
                }
            }
        }
        Ok(full)
    }
}

/// Orin Cloud — chat routed through orinai.org's `/api/chat`, metered by the
/// user's plan server-side. The upstream is non-streaming today, so the
/// finished answer is delivered as a single `ai-chunk`.
pub mod orin_cloud {
    use super::*;
    use crate::bridge::auth;
    use tauri::Manager;

    pub async fn stream(
        app: &AppHandle,
        request_id: &str,
        system: &Option<String>,
        messages: &[AiMessage],
        abort: Arc<AtomicBool>,
    ) -> StreamResult {
        let _ = system; // v1: the server applies its own tone/memory instructions
        let state = app.state::<crate::bridge::AppState>();
        let token = auth::ensure_id_token(state.inner()).await.map_err(|_| {
            "Sign in to Settings → Account to use Orin Cloud models.".to_string()
        })?;

        if abort.load(Ordering::Relaxed) {
            return Err("aborted".into());
        }
        let response = reqwest::Client::new()
            .post(format!("{}/api/chat", auth::api_base()))
            .bearer_auth(token)
            .json(&chat_payload(messages))
            .send()
            .await
            .map_err(|error| format!("Network error contacting Orin AI: {error}"))?;

        let status = response.status().as_u16();
        if status == 401 {
            return Err("Your session expired. Open Settings → Account and sign in again.".into());
        }
        if status == 429 {
            return Err("You've hit your Orin AI plan limit for now. It resets daily.".into());
        }
        if !(200..300).contains(&status) {
            let detail = response.text().await.unwrap_or_default();
            return Err(format!("Orin AI error {status}. {detail}"));
        }
        let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        let text = value["text"].as_str().unwrap_or_default().to_string();

        let _ = app.emit(
            "ai-chunk",
            serde_json::json!({ "requestId": request_id, "delta": text }),
        );
        Ok(value["text"].as_str().unwrap_or_default().to_string())
    }

    /// Plain-chat contract (verified against api/chat.js): latest user turn is
    /// `prompt`; every prior non-empty turn becomes `history` verbatim.
    pub fn chat_payload(messages: &[AiMessage]) -> serde_json::Value {
        let turns: Vec<(String, String)> = messages
            .iter()
            .filter_map(|m| {
                let content = m
                    .parts
                    .iter()
                    .filter(|part| part.kind == "text")
                    .map(|part| part.text.clone())
                    .collect::<Vec<_>>()
                    .join("\n");
                (!content.is_empty()).then(|| (m.role.clone(), content))
            })
            .collect();
        let prompt = turns
            .last()
            .filter(|(role, _)| role == "user")
            .map(|(_, content)| content.clone())
            .unwrap_or_default();
        let mut history = turns;
        if !prompt.is_empty() {
            history.pop();
        }
        let history: Vec<serde_json::Value> = history
            .into_iter()
            .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
            .collect();
        serde_json::json!({ "mode": "chat", "prompt": prompt, "history": history })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn msg(role: &str, text: &str) -> AiMessage {
            AiMessage {
                role: role.into(),
                parts: vec![MessagePart {
                    kind: "text".into(),
                    text: text.into(),
                    media_type: String::new(),
                    base64: String::new(),
                }],
            }
        }

        #[test]
        fn payload_matches_backend_contract() {
            let payload =
                chat_payload(&[msg("user", "hi"), msg("assistant", "hello"), msg("user", "bye")]);
            assert_eq!(payload["mode"], "chat");
            assert_eq!(payload["prompt"], "bye");
            assert_eq!(payload["history"].as_array().unwrap().len(), 2);
            assert_eq!(payload["history"][0]["role"], "user");
            assert_eq!(payload["history"][0]["content"], "hi");
            assert_eq!(payload["history"][1]["role"], "assistant");
            assert_eq!(payload["history"][1]["content"], "hello");
        }

        #[test]
        fn empty_history_when_only_prompt() {
            let payload = chat_payload(&[msg("assistant", "welcome"), msg("user", "go")]);
            assert_eq!(payload["prompt"], "go");
            assert_eq!(payload["history"].as_array().unwrap().len(), 1); // welcome kept
            let solo = chat_payload(&[msg("user", "only")]);
            assert_eq!(solo["history"].as_array().unwrap().len(), 0);
        }
    }
}
