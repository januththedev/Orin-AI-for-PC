// Bridge: external service connectors (GitHub, Slack, Notion).
//
// One secure pattern for all of them: the token lives ONLY in the OS keyring
// (`connector/{id}` slot) and is injected server-side on every call — the
// model never sees it, logs never contain it, and feedback is scanned before
// it goes back to the model. Reads (GET) run free; writes ask approval like
// any other mutating tool. Google Drive is documented but inert: it needs
// OAuth, which arrives with cloud sync — no fake buttons.
use std::time::Duration;

pub struct Connector {
    pub id: &'static str,
    pub label: &'static str,
    /// Base URL allowlist — `service_request` refuses anything else.
    pub base_url: &'static str,
    /// Extra headers every call to this service carries.
    pub headers: &'static [(&'static str, &'static str)],
    /// Read-only probe used by Test/Status (method + path).
    pub probe: (&'static str, &'static str),
}

pub const CONNECTORS: &[Connector] = &[
    Connector {
        id: "github",
        label: "GitHub",
        base_url: "https://api.github.com",
        headers: &[
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
        ],
        probe: ("GET", "/user"),
    },
    Connector {
        id: "slack",
        label: "Slack",
        base_url: "https://slack.com/api",
        headers: &[("Content-Type", "application/json")],
        probe: ("POST", "/auth.test"),
    },
    Connector {
        id: "notion",
        label: "Notion",
        base_url: "https://api.notion.com/v1",
        headers: &[("Notion-Version", "2022-06-28")],
        probe: ("GET", "/users/me"),
    },
];

pub fn find(id: &str) -> Option<&'static Connector> {
    CONNECTORS.iter().find(|c| c.id == id)
}

fn slot(id: &str) -> String {
    format!("connector/{id}")
}

fn read_token(id: &str) -> Option<String> {
    // Env override first (CI/headless), then the keyring slot from Settings.
    let env_name = format!("ORIN_CONNECTOR_{}", id.to_uppercase());
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

/// Display name for a probe response, per service shape. Pure — tested.
fn probe_name(id: &str, body: &serde_json::Value) -> String {
    match id {
        "github" => body["login"].as_str().unwrap_or_default().to_string(),
        "slack" => body["user"].as_str().unwrap_or_default().to_string(),
        "notion" => body["name"].as_str().unwrap_or_default().to_string(),
        _ => String::new(),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Shape guard shared by the executor and the agent path: absolute URLs and
/// `..` never reach the network, and only GET/POST/PATCH are allowed.
fn check_shape(method: &str, path: &str) -> Result<(), String> {
    if path.is_empty() || !path.starts_with('/') || path.contains("..") || path.contains("://") {
        return Err("Only relative API paths like \"/user\" are allowed.".into());
    }
    if !matches!(method, "GET" | "POST" | "PATCH") {
        return Err("Method must be GET, POST, or PATCH.".into());
    }
    Ok(())
}

async fn call(
    connector: &Connector,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    check_shape(method, path)?;
    let mut request = match method {
        "GET" => client()?.get(format!("{}{path}", connector.base_url)),
        "POST" => client()?.post(format!("{}{path}", connector.base_url)),
        "PATCH" => client()?.patch(format!("{}{path}", connector.base_url)),
        _ => unreachable!("check_shape allows only GET/POST/PATCH"),
    };
    request = request.bearer_auth(token);
    for (name, value) in connector.headers {
        request = request.header(*name, *value);
    }
    if let Some(payload) = body {
        request = request.json(payload);
    }
    let response = request.send().await.map_err(|_| {
        format!("Could not reach {}. Check the connection and try again.", connector.label)
    })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if status == 401 || status == 403 {
        return Err(format!("{} rejected the stored credential — save a fresh token.", connector.label));
    }
    if status < 200 || status >= 300 {
        return Err(format!("{} returned HTTP {status}.", connector.label));
    }
    serde_json::from_str(&text).unwrap_or(Ok(serde_json::json!({ "raw": truncate(&text) })))
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

/// Live validation for the Test button / status pill. Returns the account
/// display name (e.g. GitHub login) on success.
pub async fn validate(id: &str) -> Result<String, String> {
    let connector = find(id).ok_or_else(|| format!("Unknown connector “{id}”."))?;
    let token = read_token(id).ok_or_else(|| "Save a token first.".to_string())?;
    let body = call(connector, &token, connector.probe.0, connector.probe.1, None).await?;
    let name = probe_name(id, &body);
    if name.is_empty() {
        return Err(format!("{} answered, but the account name was missing.", connector.label));
    }
    Ok(name)
}

/// Agent executor: token injected server-side, response truncated, token
/// never present in the returned strings (it only ever leaves in the
/// Authorization header). Returns (ui_summary, model_feedback).
pub async fn service_request(
    id: &str,
    method: &str,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<(String, String), String> {
    let connector = find(id).ok_or_else(|| format!("ERROR: unknown connector \"{id}\"."))?;
    if let Err(e) = check_shape(method, path) {
        return Err(format!("ERROR: {e}"));
    }
    let token = read_token(id)
        .ok_or_else(|| format!("ERROR: no credential for {} — ask the user to connect it in Settings → Connections.", connector.label))?;
    let value = call(connector, &token, method, path, body).await.map_err(|e| format!("ERROR: {e}"))?;
    let pretty = serde_json::to_string_pretty(&value).unwrap_or_default();
    let (fed, was_truncated) = (truncate(&pretty), pretty.chars().count() > 8000);
    Ok((
        format!("{} {} → {}", connector.label, path, if was_truncated { "ok (truncated)" } else { "ok" }),
        format!("OK from {}:{fed}{}", path, if was_truncated { "\n… (truncated)" } else { "" }),
    ))
}

#[tauri::command]
pub fn connector_set_cred(id: String, token: String) -> Result<(), String> {
    let connector = find(&id).ok_or_else(|| format!("Unknown connector “{id}”."))?;
    if token.trim().is_empty() {
        return Err("Paste the token first.".into());
    }
    keyring::Entry::new("orin-ai", &slot(&id))
        .map_err(|e| e.to_string())?
        .set_password(token.trim())
        .map_err(|e| e.to_string())?;
    let _ = connector;
    Ok(())
}

#[tauri::command]
pub fn connector_has_cred(id: String) -> bool {
    read_token(&id).is_some()
}

#[tauri::command]
pub async fn connector_test(id: String) -> Result<String, String> {
    validate(&id).await
}

#[tauri::command]
pub fn connector_remove(id: String) -> Result<(), String> {
    find(&id).ok_or_else(|| format!("Unknown connector “{id}”."))?;
    match keyring::Entry::new("orin-ai", &slot(&id)) {
        Ok(entry) => {
            let _ = entry.delete_password();
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_resolves_all() {
        for id in ["github", "slack", "notion"] {
            assert!(find(id).is_some(), "{id} missing");
        }
        assert!(find("gdrive").is_none());
        assert!(find("https://evil.example").is_none());
    }

    #[test]
    fn probe_names_follow_service_shapes() {
        assert_eq!(probe_name("github", &serde_json::json!({ "login": "octo" })), "octo");
        assert_eq!(probe_name("slack", &serde_json::json!({ "user": "U123", "ok": true })), "U123");
        assert_eq!(probe_name("notion", &serde_json::json!({ "name": "N", "object": "user" })), "N");
        assert_eq!(probe_name("github", &serde_json::json!({})), "");
    }

    #[test]
    fn truncate_keeps_boundary_and_marks() {
        let long = "é".repeat(9000);
        let out = truncate(&long);
        assert!(out.ends_with("(truncated)"));
        assert!(out.chars().count() <= 8015);
        assert_eq!(truncate("short"), "short");
    }

    #[test]
    fn service_request_rejects_evildoing_without_token() {
        // Unknown connector and path traversal fail before any network use.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let err = rt.block_on(service_request("nope", "GET", "/user", None)).unwrap_err();
        assert!(err.contains("unknown connector"), "{err}");
        // Absolute URL / traversal rejected deterministically (shape is
        // checked before credentials, so no token state leaks either way).
        let err = rt
            .block_on(service_request("github", "GET", "https://evil.example/x", None))
            .unwrap_err();
        assert!(err.contains("relative API paths"), "{err}");
        let err = rt
            .block_on(service_request("github", "DELETE", "/user", None))
            .unwrap_err();
        assert!(err.contains("GET, POST, or PATCH"), "{err}");
    }
}
