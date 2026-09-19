// Bridge: MCP (Model Context Protocol) clients over Streamable HTTP.
//
// This is how Gmail / Drive / OneDrive / etc. connect with NO Google Cloud
// or Azure app setup: a hosted MCP provider (Composio, Pipedream, Zapier
// MCP, Klavis…) owns the OAuth once, and you paste its server URL + key in
// Settings → Connections. The agent discovers tools via `mcp_list_tools`
// and calls them via `mcp_call` (approval-gated).
//
// Security mirrors connectors.rs: keys live in env (`ORIN_MCP_{ID}`) or the
// OS keyring (`mcp/{id}`) and are only ever sent as an Authorization header.
// URLs are restricted to http(s); responses are truncated before reaching
// the model. Stateless v1: no session resumption across calls.
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::AppState;

/// Protocol versions to offer, newest first. Servers that only speak an
/// older draft get a retry instead of a dead end.
const PROTOCOL_VERSIONS: &[&str] = &["2025-03-26", "2024-11-05"];
const SERVERS_KEY: &str = "mcp/servers";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
}

fn slot(id: &str) -> String {
    format!("mcp/{id}")
}

fn read_key(id: &str) -> Option<String> {
    let env_name = format!("ORIN_MCP_{}", id.to_uppercase().replace('-', "_"));
    if let Ok(token) = std::env::var(&env_name) {
        if !token.trim().is_empty() {
            return Some(token.trim().to_string());
        }
    }
    keyring::Entry::new("orin-ai", &slot(id))
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|t| !t.trim().is_empty())
}

/// Only server URLs the MCP client will ever talk to.
fn check_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Ok(())
    } else {
        Err("MCP server URL must start with http:// or https://.".into())
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// One JSON-RPC 2.0 envelope. Pure — tested.
fn rpc_envelope(id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// Pull the JSON-RPC response out of a Streamable HTTP reply, which may be
/// bare JSON or an SSE stream (`data:` lines; comments/`event:` ignored).
/// Pure — tested.
fn sse_response(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') {
        return serde_json::from_str::<serde_json::Value>(text).ok();
    }
    let mut payloads: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            if !current.trim().is_empty() {
                payloads.push(std::mem::take(&mut current));
            }
            continue;
        }
        if line.starts_with(':') {
            continue; // SSE comment / ping
        }
        if line.starts_with("event:") {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim_start();
            if data == "[DONE]" {
                continue;
            }
            current.push_str(data);
            current.push('\n');
        }
    }
    if !current.trim().is_empty() {
        payloads.push(current);
    }
    // Newest plausible response first.
    for payload in payloads.iter().rev() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
            if value.get("result").is_some() || value.get("error").is_some() {
                return Some(value);
            }
        }
    }
    None
}

fn rpc_error_message(value: &serde_json::Value) -> Option<String> {
    let error = value.get("error")?;
    let message = error["message"].as_str().unwrap_or("MCP error");
    let code = error["code"].as_i64().unwrap_or(0);
    Some(format!("MCP error {code}: {message}"))
}

/// POST one RPC call. Returns (session id if the server issued one, body).
async fn post_rpc(
    url: &str,
    key: &Option<String>,
    extra_headers: &[(&str, String)],
    body: &serde_json::Value,
) -> Result<(Option<String>, String), String> {
    let mut request = client()?
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    for (name, value) in extra_headers {
        request = request.header(*name, value.clone());
    }
    if let Some(token) = key {
        request = request.bearer_auth(token);
    }
    let response = request.json(body).send().await.map_err(|_| {
        "Could not reach the MCP server. Check the URL and connection.".to_string()
    })?;
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if status == 401 || status == 403 {
        return Err("The MCP server rejected the stored key — save a fresh one.".into());
    }
    if status == 404 {
        return Err("The MCP server has no Streamable HTTP endpoint at that URL.".into());
    }
    if !(200..300).contains(&status) {
        return Err(format!("The MCP server returned HTTP {status}."));
    }
    Ok((session, text))
}

/// Handshake: initialize (with version fallback) + initialized notice.
/// Returns a human server label like "gmail (1.4)". Session ids are used
/// within this handshake only (stateless v1).
async fn handshake(url: &str, key: &Option<String>) -> Result<(), String> {
    let mut last_error = "no protocol version accepted".to_string();
    for version in PROTOCOL_VERSIONS {
        let body = rpc_envelope(
            1,
            "initialize",
            serde_json::json!({
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": { "name": "orin-code", "version": env!("CARGO_PKG_VERSION") },
            }),
        );
        let headers = [("MCP-Protocol-Version", version.to_string())];
        match post_rpc(url, key, &headers, &body).await {
            Ok((session, text)) => {
                let value = sse_response(&text).ok_or("The MCP server answered, but not with JSON-RPC.")?;
                if let Some(message) = rpc_error_message(&value) {
                    last_error = message;
                    continue;
                }
                if value.get("result").is_none() {
                    last_error = "Initialize returned no result.".into();
                    continue;
                }
                // Best-effort initialized notice; servers must tolerate its loss.
                let notice = serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
                let session_headers: Vec<(&str, String)> = session
                    .map(|s| ("Mcp-Session-Id", s))
                    .into_iter()
                    .collect();
                let _ = post_rpc(url, key, &session_headers, &notice).await;
                return Ok(());
            }
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

async fn call_method(
    url: &str,
    key: &Option<String>,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Handshake per call keeps v1 stateless; version fallback inside.
    handshake(url, key).await?;
    let body = rpc_envelope(2, method, params);
    let (_, text) = post_rpc(url, key, &[], &body).await?;
    let value = sse_response(&text).ok_or("The MCP server answered, but not with JSON-RPC.")?;
    if let Some(message) = rpc_error_message(&value) {
        return Err(message);
    }
    value.get("result").cloned().ok_or_else(|| "The MCP server returned no result.".into())
}

fn truncate(text: &str) -> String {
    const LIMIT: usize = 8000;
    if text.chars().count() <= LIMIT {
        return text.to_string();
    }
    let mut end = LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (truncated)", &text[..end])
}

/// Flatten MCP content blocks to model-facing text. Pure — tested.
fn content_to_text(result: &serde_json::Value) -> String {
    let Some(blocks) = result.get("content").and_then(|c| c.as_array()) else {
        return serde_json::to_string_pretty(result).unwrap_or_default();
    };
    let mut out = String::new();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()).unwrap_or_default() {
            "text" => {
                out.push_str(block["text"].as_str().unwrap_or_default());
                out.push('\n');
            }
            "image" => out.push_str("[image content omitted]\n"),
            "resource" => out.push_str(&format!(
                "[resource: {}]\n",
                block.get("resource").and_then(|r| r.get("uri")).and_then(|u| u.as_str()).unwrap_or("?")
            )),
            other => out.push_str(&format!("[{other} content omitted]\n")),
        }
    }
    if result["isError"].as_bool().unwrap_or(false) {
        out.push_str("\n(tool reported an error)");
    }
    out.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// Stored servers + keyring
// ---------------------------------------------------------------------------

fn load_servers(state: &AppState) -> Vec<McpServerConfig> {
    super::store::read_setting(state, SERVERS_KEY)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_servers(state: &AppState, servers: &[McpServerConfig]) -> Result<(), String> {
    let raw = serde_json::to_string(servers).map_err(|e| e.to_string())?;
    super::store::write_setting(state, SERVERS_KEY, &raw)
}

fn find_server(state: &AppState, id: &str) -> Result<(McpServerConfig, Option<String>), String> {
    let config = load_servers(state)
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("ERROR: unknown MCP server \"{id}\"."))?;
    check_url(&config.url).map_err(|e| format!("ERROR: {e}"))?;
    Ok((config.clone(), read_key(id)))
}

// ---------------------------------------------------------------------------
// Agent executors (token injected server-side, never in feedback)
// ---------------------------------------------------------------------------

/// List a server's tools for discovery. Free (no approval).
pub async fn agent_list_tools(
    state: &AppState,
    server_id: &str,
) -> Result<(String, String), String> {
    let (config, key) = find_server(state, server_id)?;
    let result = call_method(&config.url, &key, "tools/list", serde_json::json!({})).await
        .map_err(|e| format!("ERROR: {e}"))?;
    let tools = result
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    if tools.is_empty() {
        return Ok((
            format!("{} has no tools", config.name),
            format!("OK: {} listed 0 tools.", config.name),
        ));
    }
    let names: Vec<String> = tools
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_string))
        .collect();
    let mut detail = String::new();
    for tool in tools.iter().take(40) {
        detail.push_str(&format!(
            "- {}: {}\n",
            tool["name"].as_str().unwrap_or("?"),
            tool["description"].as_str().unwrap_or_default()
        ));
    }
    Ok((
        format!("{} · {} tools", config.name, names.len()),
        format!("OK: {} tools on {}:\n{detail}", names.len(), config.name),
    ))
}

/// Call one MCP tool. The caller (agent loop) gates this behind approval —
/// MCP tools can send mail, move files, and spend money.
pub async fn agent_call(
    state: &AppState,
    server_id: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<(String, String), String> {
    if tool.trim().is_empty() {
        return Err("ERROR: mcp_call needs a tool name — discover them with mcp_list_tools first.".into());
    }
    let (config, key) = find_server(state, server_id)?;
    let result = call_method(
        &config.url,
        &key,
        "tools/call",
        serde_json::json!({ "name": tool, "arguments": arguments }),
    )
    .await
    .map_err(|e| format!("ERROR: {e}"))?;
    let text = truncate(&content_to_text(&result));
    Ok((format!("{} → {tool}", config.name), format!("OK from {}:\n{text}", config.name)))
}

// ---------------------------------------------------------------------------
// Tauri commands (Settings → Connections)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mcp_servers(state: tauri::State<'_, AppState>) -> Vec<serde_json::Value> {
    load_servers(state.inner())
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "name": s.name,
                "url": s.url,
                "hasKey": read_key(&s.id).is_some(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn mcp_add_server(name: String, url: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Give the server a name first.".into());
    }
    check_url(url.trim())?;
    let mut servers = load_servers(state.inner());
    let id = uuid::Uuid::new_v4().to_string();
    servers.push(McpServerConfig { id: id.clone(), name: name.trim().to_string(), url: url.trim().to_string() });
    save_servers(state.inner(), &servers)?;
    Ok(id)
}

#[tauri::command]
pub fn mcp_remove_server(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let servers: Vec<McpServerConfig> =
        load_servers(state.inner()).into_iter().filter(|s| s.id != id).collect();
    save_servers(state.inner(), &servers)?;
    if let Ok(entry) = keyring::Entry::new("orin-ai", &slot(&id)) {
        let _ = entry.delete_password();
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_set_key(id: String, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("Paste the key first.".into());
    }
    keyring::Entry::new("orin-ai", &slot(&id))
        .map_err(|e| e.to_string())?
        .set_password(key.trim())
        .map_err(|e| e.to_string())
}

/// Handshake + tool count, e.g. "Gmail · 14 tools". Proves URL + key work.
#[tauri::command]
pub async fn mcp_test(id: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (config, key) = find_server(state.inner(), &id)?;
    let result = call_method(&config.url, &key, "tools/list", serde_json::json!({})).await?;
    let count = result.get("tools").and_then(|t| t.as_array()).map(|t| t.len()).unwrap_or(0);
    Ok(format!("{} · {count} tools", config.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_is_jsonrpc() {
        let env = rpc_envelope(7, "tools/list", serde_json::json!({}));
        assert_eq!(env["jsonrpc"], "2.0");
        assert_eq!(env["id"], 7);
        assert_eq!(env["method"], "tools/list");
    }

    #[test]
    fn url_guard_allows_only_http() {
        assert!(check_url("https://mcp.example.com/mcp").is_ok());
        assert!(check_url("http://localhost:8000/sse").is_ok());
        assert!(check_url("stdio:gmail").is_err());
        assert!(check_url("file:///x").is_err());
        assert!(check_url("").is_err());
    }

    #[test]
    fn sse_parses_stream_and_json() {
        let json = sse_response(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#).unwrap();
        assert!(json["result"]["ok"].as_bool().unwrap());

        let stream = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\ndata: [DONE]\n";
        let parsed = sse_response(stream).unwrap();
        assert_eq!(parsed["id"], 2);

        // Comments and pings never parse as responses.
        assert!(sse_response(": ping\n\n").is_none());
        assert!(sse_response("not json at all").is_none());
    }

    #[test]
    fn content_blocks_flatten() {
        let result = serde_json::json!({
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "image", "data": "…", "mimeType": "image/png" },
                { "type": "resource", "resource": { "uri": "gmail://m/1" } },
            ]
        });
        let text = content_to_text(&result);
        assert!(text.contains("hello"));
        assert!(text.contains("[image content omitted]"));
        assert!(text.contains("gmail://m/1"));

        let err = serde_json::json!({ "content": [{ "type": "text", "text": "nope" }], "isError": true });
        assert!(content_to_text(&err).contains("reported an error"));
    }

    #[test]
    fn error_envelopes_surface() {
        let value = serde_json::json!({ "error": { "code": -32602, "message": "bad params" } });
        assert_eq!(rpc_error_message(&value).unwrap(), "MCP error -32602: bad params");
        assert!(rpc_error_message(&serde_json::json!({ "result": {} })).is_none());
    }
}
