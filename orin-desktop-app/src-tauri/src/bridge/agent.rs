// Agent tool-use loop. The model drives itself through a plain-text protocol:
// it emits <tool_call>{"name":...,"input":{...}}</tool_call> blocks in its
// reply, we execute them (with diffs + approvals for anything destructive),
// feed results back as <tool_result> user messages, and repeat until the model
// replies without any tool calls. Works with every provider in ai_impl because
// it needs no native tool-use APIs.
use super::ai::{AiMessage, MessagePart};
use super::ai_impl;
use super::AppState;
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Deserialize)]
pub struct AgentTask {
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub mode: String,
    pub instructions: String,
    #[serde(default)]
    pub history: serde_json::Value,
    #[serde(rename = "workspaceRoot", default)]
    pub workspace_root: Option<String>,
    #[serde(rename = "projectInstructions", default)]
    pub project_instructions: Option<String>,
    /// Phone-confirmed remote tasks only: the user already tapped Run on
    /// Telegram, so approvals auto-resolve (still emitted + logged).
    /// NEVER set for local runs — the UI never offers it.
    #[serde(default, rename = "autoApprove")]
    pub auto_approve: bool,
}

#[derive(Deserialize)]
struct ToolCall {
    name: String,
    #[serde(default)]
    input: serde_json::Value,
}

const MAX_ITERATIONS: usize = 12;
/// Characters of file content fed back to the model per read.
const TOOL_RESULT_CHAR_LIMIT: usize = 12_000;
const COMMAND_TIMEOUT_SECS: u64 = 120;
const APPROVAL_TIMEOUT_SECS: u64 = 600; // 10 minutes

const TOOL_PROTOCOL: &str = "\
\n\n## Acting with tools\n\
You are operating with tools inside the user's real workspace. Every tool call must move the request forward.\n\
Call format — embed blocks EXACTLY like this (ONE JSON object per block; several blocks per reply run in order):\n\
<tool_call>{\"name\":\"read_file\",\"input\":{\"path\":\"src/main.rs\"}}</tool_call>\n\
Rules:\n\
- Output contract: plain text PLUS tool_call blocks. Never prose inside a block; never invent results — wait for <tool_result>.\n\
- Explore first: list_dir/read_file BEFORE editing. NEVER edit a file you have not read this run (str_replace enforces this).\n\
- Smallest sufficient change: prefer str_replace (one exact block) over write_file (whole file).\n\
- After any edit, re-read the edited region to confirm, and run the project's checks (tests/lint/build) via run_command when they exist.\n\
- service_request reaches connected external services (github/slack/notion). Tokens are injected server-side — never ask the user for them.\n\
- write_file, str_replace, run_command, service_request writes, and desktop-control actions ask the user and may be declined; a decline is FINAL — work around it or report back, never retry the same call.\n\
- On ERROR: read the message, fix YOUR input (wrong path? bad JSON shape? missing read?), retry differently at most twice, then change approach or report. NEVER emit the identical call twice in a row.\n\
- When finished, or when no tool is needed, reply with plain text only (no tool_call blocks).\n\
- Research questions: if a research MCP server (e.g. Consensus) is connected, search it via mcp_list_tools/mcp_call and ground the answer in real papers — cite title, year, and DOI or journal for each claim, and say plainly when evidence is thin.\n\n\
Available tools:\n\
- read_file(path) — read a text file (workspace-relative unless absolute).\n\
- list_dir(path) — list a directory (\".\" = root).\n\
- search_files(query) — case-insensitive text search.\n\
- str_replace(path, old_str, new_str) — replace ONE exact occurrence (read first; 0 or 2+ matches → retry with more context).\n\
- write_file(path, content) — create/overwrite whole file (prefer str_replace for edits).\n\
- run_command(command) — shell in workspace (120s limit, cmd.exe on Windows).\n\
- service_request(service, method, path, body?) — connected services only (GET runs free; POST/PATCH ask approval). service is github | slack | notion; path is relative. Examples: {\"service\":\"github\",\"method\":\"POST\",\"path\":\"/repos/OWNER/REPO/issues\",\"body\":{\"title\":\"…\"}} · {\"service\":\"slack\",\"method\":\"POST\",\"path\":\"/chat.postMessage\",\"body\":{\"channel\":\"C…\",\"text\":\"…\"}} · {\"service\":\"notion\",\"method\":\"POST\",\"path\":\"/search\",\"body\":{\"query\":\"…\"}}.\n\
- mcp_list_tools(server) — list an MCP server's tools (free). External apps (Gmail, Drive, OneDrive…) live behind MCP servers: call this FIRST to learn exact tool names and arguments.\n\
- mcp_call(server, tool, arguments) — call one MCP tool (always asks approval; keys are injected server-side, never ask for them). arguments is the JSON object the tool expects.\n";

/// Desktop control (real Windows machine). Coordinates are normalized 0..1000
/// across the whole screen, exactly like Computer Use. `screenshot` returns
/// the actual screen as an image you can look at before acting.
const DESKTOP_TOOLS_PROTOCOL: &str = "\
- screenshot() — capture the screen; you will SEE it as an image in the next message.\n\
- mouse_move(x, y) — move the cursor (coordinates 0..1000, top-left = 0,0).\n\
- mouse_click(x, y, button) — move and click (button: left | right | double).\n\
- type_text(text) — type text into the focused window.\n\
- press_key(key) — press a key or combo (\"enter\", \"ctrl+s\", \"alt+tab\"…).\n\
- scroll(x, y, amount) — wheel scroll at a point (positive = up).\n\
- open_app(name) — launch an application (e.g. \"notepad\", \"calc\", \"chrome\").\n\
- focus_window(title) — bring a window whose title contains this text to the front.\n";

fn build_system(task: &AgentTask, root: Option<&str>, desktop_enabled: bool) -> String {
    let tools_enabled = root.is_some();
    let mut system = format!(
        "You are Orin, an expert AI coding agent working inside the Orin Code desktop app. \
         Be concise, practical and safe. Think step by step, act decisively, verify everything. Current mode: {}. ",
        task.mode
    );
    if let Some(extra) = task.project_instructions.as_deref() {
        if !extra.trim().is_empty() {
            system.push_str("\n\nProject instructions from the active project:\n");
            system.push_str(extra.trim());
        }
    }
    if tools_enabled {
        system.push_str(TOOL_PROTOCOL);
    }
    if let Some(root) = root {
        system.push_str(&format!(
            "\n\nEnvironment: Windows 11, workspace root `{root}` (all relative paths resolve here), shell is cmd.exe. Connected external services, if any, are reachable via service_request — their credentials are handled for you.\n"
        ));
    }
    if task.mode == "plan" {
        system.push_str(
            "\n\nPlan mode: investigate with read-only tools only and finish with a \
             step-by-step plan. Never emit write_file, str_replace, run_command, or \
             desktop-control tool calls in this mode.\n",
        );
    }
    if desktop_enabled {
        system.push_str("\nControl this PC (only when the user asks you to operate their computer):\n");
        system.push_str(DESKTOP_TOOLS_PROTOCOL);
        system.push_str(
            "\nDesktop rules: ALWAYS screenshot first, look at it, then act on what you see. \
             After typing or clicking, screenshot again to verify the result before moving on. \
             Never guess pixel positions from memory.\n",
        );
    } else if !tools_enabled {
        system.push_str(
            "\n\nNo workspace folder is open, so no tools are available: answer the user \
             directly in plain text and never emit tool_call blocks.",
        );
    }
    system
}

fn text_message(role: &str, text: &str) -> AiMessage {
    AiMessage {
        role: role.to_string(),
        parts: vec![MessagePart {
            kind: "text".into(),
            text: text.to_string(),
            media_type: String::new(),
            base64: String::new(),
        }],
    }
}

// ---------------------------------------------------------------------------
// Trajectory log (harness-style append-only session record)
// ---------------------------------------------------------------------------

/// Best-effort JSONL record of a run — the harness idea that every run is
/// reconstructable from a single session log. Each assistant reply, tool
/// call/result, and completion lands here in order at
/// `{workspace}/.orin-trajectory/{run_id}.jsonl`. The UI already streams the
/// same items as `agent-event`s; this file is the durable copy used for
/// resume/fork/replay debugging. Logging never blocks or fails the run.
struct Trajectory {
    path: Option<std::path::PathBuf>,
    seq: u64,
}

impl Trajectory {
    fn new(root: &Option<String>, run_id: &str) -> Self {
        let path = root.as_ref().and_then(|r| {
            let dir = std::path::Path::new(r).join(".orin-trajectory");
            std::fs::create_dir_all(&dir).ok()?;
            Some(dir.join(format!("{run_id}.jsonl")))
        });
        Self { path, seq: 0 }
    }

    fn log(&mut self, kind: &str, data: serde_json::Value) {
        let Some(path) = self.path.clone() else { return };
        self.seq += 1;
        let record = json!({
            "seq": self.seq,
            "kind": kind,
            "data": data,
        });
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write as _;
            let _ = writeln!(file, "{record}");
        }
    }
}

/// Canonical key for the read-before-edit policy: resolved path with
/// normalized separators so `read_file` and `str_replace` agree on Windows.
fn display_key(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Surgical string replacement — the harness-style str-replace editor core.
/// Exactly one match of `old_str` is replaced. Zero matches → not-found error;
/// 2+ matches → ambiguous error asking for more context. A CRLF-tolerant retry
/// covers models that normalize Windows line endings to `\n`, without ever
/// rewriting the rest of the file's endings.
fn apply_str_replace(content: &str, old_str: &str, new_str: &str) -> Result<String, String> {
    if old_str.is_empty() {
        return Err("old_str must not be empty — copy the exact block to replace.".into());
    }
    let matches = content.matches(old_str).count();
    if matches == 1 {
        return Ok(content.replacen(old_str, new_str, 1));
    }
    if matches > 1 {
        return Err(format!(
            "old_str matches {matches} places — retry with more surrounding context so it matches exactly once."
        ));
    }
    // CRLF-tolerant retry: the file uses \r\n but the model sent \n anchors.
    if content.contains('\r') {
        let old_crlf = old_str.replace("\r\n", "\n").replace('\n', "\r\n");
        let crlf_matches = content.matches(old_crlf.as_str()).count();
        if crlf_matches == 1 {
            let new_crlf = new_str.replace("\r\n", "\n").replace('\n', "\r\n");
            return Ok(content.replacen(old_crlf.as_str(), new_crlf.as_str(), 1));
        }
        if crlf_matches > 1 {
            return Err(format!(
                "old_str matches {crlf_matches} places — retry with more surrounding context so it matches exactly once."
            ));
        }
    }
    Err("old_str not found in the file — read the file again and copy the exact text.".into())
}

#[tauri::command]
pub async fn agent_run(task: AgentTask, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    if task.instructions.trim().is_empty() {
        return Err("Give me something to work on first — describe what you need.".into());
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let flag = state.register_flag(&run_id);
    let approvals = state.approvals.clone();
    let openai_base = super::store::read_setting(&state, "openai_compat/baseUrl");

    tauri::async_runtime::spawn(run_loop(
        app.clone(),
        run_id.clone(),
        task,
        flag,
        approvals,
        openai_base,
    ));
    Ok(run_id)
}

#[tauri::command]
pub fn agent_stop(run_id: String, state: State<'_, AppState>) {
    state.trip_flag(&run_id);
}

#[tauri::command]
pub fn approval_respond(approval_id: String, approved: bool, state: State<'_, AppState>) {
    if let Ok(mut approvals) = state.approvals.lock() {
        approvals.insert(approval_id, approved);
    }
}

async fn run_loop(
    app: AppHandle,
    run_id: String,
    task: AgentTask,
    flag: Arc<AtomicBool>,
    approvals: Arc<Mutex<HashMap<String, bool>>>,
    openai_base: Option<String>,
) {
    let emit = |event: serde_json::Value| {
        let _ = app.emit("agent-event", json!({ "runId": run_id, "event": event }));
    };

    let root = task
        .workspace_root
        .clone()
        .map(|r| r.trim().trim_matches(['/', '\\']).to_string())
        .filter(|r| !r.is_empty());

    let mut messages: Vec<AiMessage> =
        serde_json::from_value(task.history.clone()).unwrap_or_default();
    messages.push(text_message("user", &task.instructions));

    // Harness record + read-before-edit tracking for this run.
    let mut trajectory = Trajectory::new(&root, &run_id);
    trajectory.log(
        "run_start",
        json!({ "model": task.model_id, "mode": task.mode, "instructions": task.instructions }),
    );
    let mut read_set: HashSet<String> = HashSet::new();
    // Phone mirror: approvals also reach the linked Telegram (Orin Code bot)
    // when the user paired it; silently local-only otherwise.
    let mut mirror = {
        let state = app.state::<super::AppState>();
        super::telegram::mirror_for_run(state.inner()).await
    };
    // Phone-confirmed remote tasks arrive pre-approved (the user tapped Run
    // for this exact task). Local runs always ask.
    let auto_approve = task.auto_approve;

    // Desktop control is a real-machine capability (GDI capture + SendInput).
    let desktop_enabled = cfg!(windows);
    let mut policy = super::cu::policy::SessionPolicy::new("windows");
    let mut desktop: Option<super::cu::AnyController> = None;

    let system = Some(build_system(&task, root.as_deref(), desktop_enabled));
    let mut plan_emitted = false;
    let mut step_index = 0usize;
    // Loop guards: identical repeat = loop, 3 straight errors = stuck.
    let mut last_call_sig: Option<String> = None;
    let mut strikes = 0u8;

    for iteration in 0..MAX_ITERATIONS {
        if flag.load(Ordering::Relaxed) {
            trajectory.log("done", json!({ "summary": "Stopped." }));
            emit(json!({ "kind": "done", "summary": "Stopped." }));
            return;
        }

        // Unique requestId per iteration so streamed ai-chunks never collide
        // with chat traffic.
        let request_id = format!("agent-{run_id}-{iteration}");
        let reply = match ai_impl::generate(
            &app,
            &request_id,
            &task.model_id,
            &system,
            &messages,
            flag.clone(),
            openai_base.clone(),
        )
        .await
        {
            Ok(text) => text,
            Err(error) if error == "aborted" => {
                trajectory.log("done", json!({ "summary": "Stopped." }));
                emit(json!({ "kind": "done", "summary": "Stopped." }));
                return;
            }
            Err(error) => {
                trajectory.log("error", json!({ "error": error }));
                emit(json!({ "kind": "error", "error": error }));
                return;
            }
        };

        trajectory.log(
            "assistant",
            json!({ "iteration": iteration, "chars": reply.chars().count(), "text": reply }),
        );

        if !plan_emitted {
            plan_emitted = true;
            emit(json!({ "kind": "plan", "steps": plan_from(&task.instructions, &reply) }));
        }

        let calls = parse_tool_calls(&reply);
        // Repeat breaker: the identical call twice in a row is a loop, not
        // progress — end the run with an explanation instead of burning it.
        if calls.len() == 1 {
            let sig = call_sig(&calls[0]);
            if last_call_sig.as_deref() == Some(sig.as_str()) {
                let summary = "Stopped: I repeated the same tool call twice — ending the run instead of looping. Check the error above and run again with corrected input.";
                trajectory.log("done", json!({ "summary": summary }));
                emit(json!({ "kind": "done", "summary": summary }));
                return;
            }
            last_call_sig = Some(sig);
        } else {
            last_call_sig = None;
        }
        if calls.is_empty() {
            let clean = strip_tool_blocks(&reply);
            if !clean.trim().is_empty() {
                emit(json!({ "kind": "assistant-message", "text": clean }));
            }
            let summary = summarize(&clean);
            trajectory.log("done", json!({ "summary": summary }));
            emit(json!({ "kind": "done", "summary": summary }));
            return;
        }
        if root.is_none() && !desktop_enabled {
            // The model tried to call tools with no workspace open; its reply
            // (minus the blocks) is simply the answer.
            let clean = strip_tool_blocks(&reply);
            emit(json!({ "kind": "assistant-message", "text": clean }));
            let summary = summarize(&clean);
            trajectory.log("done", json!({ "summary": summary }));
            emit(json!({ "kind": "done", "summary": summary }));
            return;
        }

        messages.push(text_message("assistant", &reply));
        let mut results = String::new();
        let mut frames: Vec<AiMessage> = Vec::new();

        for call in calls {
            if flag.load(Ordering::Relaxed) {
                trajectory.log("done", json!({ "summary": "Stopped." }));
                emit(json!({ "kind": "done", "summary": "Stopped." }));
                return;
            }
            if !is_supported_tool(&call.name, root.is_some(), desktop_enabled) {
                results.push_str(&format!(
                    "<tool_result tool=\"{}\">ERROR: unknown or unavailable tool.</tool_result>\n",
                    call.name
                ));
                continue;
            }
            let target = tool_target(&call.name, &call.input);
            let call_id = uuid::Uuid::new_v4().to_string();
            trajectory.log("tool_start", json!({ "tool": call.name, "input": call.input }));
            emit(json!({
                "kind": "tool-start",
                "toolCallId": call_id,
                "tool": call.name,
                "input": call.input,
            }));
            emit(json!({ "kind": "step", "index": step_index, "status": "running", "label": label_for(&call.name, &target) }));

            let (ok, summary, feedback, frame) = execute_tool(
                &app, &emit, &root, &call, &approvals, &flag, &mut policy, &mut desktop,
                &mut read_set, &mut mirror, auto_approve,
            )
            .await;
            if let Some((jpeg_b64, width, height)) = frame {
                // Feed the screen back as an image the model can actually see.
                frames.push(AiMessage {
                    role: "user".into(),
                    parts: vec![
                        MessagePart {
                            kind: "image".into(),
                            text: String::new(),
                            media_type: "image/jpeg".into(),
                            base64: jpeg_b64,
                        },
                        MessagePart {
                            kind: "text".into(),
                            text: format!(
                                "screenshot ({width}x{height}, normalized 0..1000 coordinates)"
                            ),
                            media_type: String::new(),
                            base64: String::new(),
                        },
                    ],
                });
            }
            emit(json!({
                "kind": "tool-end",
                "toolCallId": call_id,
                "ok": ok,
                "summary": summary,
            }));
            trajectory.log("tool_end", json!({ "tool": call.name, "ok": ok, "summary": summary }));
            // Strike breaker: 3 consecutive errors means stuck — stop with
            // the trail instead of spending the remaining iterations.
            if ok {
                strikes = 0;
            } else {
                strikes += 1;
                if strikes >= 3 {
                    let stop = format!("Stopping after 3 consecutive tool errors (last: {summary}). Fix the inputs above and run again.");
                    trajectory.log("done", json!({ "summary": stop }));
                    emit(json!({ "kind": "done", "summary": stop }));
                    return;
                }
            }
            emit(json!({ "kind": "step", "index": step_index, "status": "done", "label": label_for(&call.name, &target) }));
            step_index += 1;

            let attr = match call.name.as_str() {
                "read_file" | "write_file" | "str_replace" | "list_dir" => format!(" path=\"{}\"", target),
                "mcp_list_tools" | "mcp_call" => format!(" server=\"{}\"", target),
                _ => String::new(),
            };
            results.push_str(&format!(
                "<tool_result tool=\"{}\"{}>{}</tool_result>\n",
                xml_escape(&call.name),
                attr,
                feedback
            ));
        }

        for frame in frames.drain(..) {
            messages.push(frame);
        }
        messages.push(text_message("user", &results));
    }

    emit(json!({
        "kind": "done",
        "summary": "Reached the step limit for this run — ask me to continue where I left off."
    }));
    trajectory.log("done", json!({ "summary": "Reached the step limit for this run." }));
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

fn is_supported_tool(name: &str, tools_enabled: bool, desktop_enabled: bool) -> bool {
    if desktop_enabled && is_desktop_tool(name) {
        return true;
    }
    if !tools_enabled {
        return false;
    }
    matches!(name, "read_file" | "list_dir" | "search_files" | "write_file" | "str_replace" | "run_command" | "service_request" | "mcp_list_tools" | "mcp_call")
}

fn is_desktop_tool(name: &str) -> bool {
    matches!(
        name,
        "screenshot"
            | "mouse_move"
            | "mouse_click"
            | "type_text"
            | "press_key"
            | "scroll"
            | "open_app"
            | "focus_window"
    )
}

fn input_str(input: &serde_json::Value, key: &str) -> Option<String> {
    let value = input.get(key)?;
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    match value {
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn tool_target(tool: &str, input: &serde_json::Value) -> String {
    match tool {
        "read_file" | "write_file" | "str_replace" => input_str(input, "path").unwrap_or_default(),
        "list_dir" => input_str(input, "path").unwrap_or_else(|| ".".into()),
        "search_files" => input_str(input, "query").unwrap_or_default(),
        "run_command" => input_str(input, "command").unwrap_or_default(),
        "service_request" => {
            let service = input_str(input, "service").unwrap_or_default();
            let path = input_str(input, "path").unwrap_or_default();
            format!("{service} {path}").trim().to_string()
        }
        "mcp_list_tools" => input_str(input, "server").unwrap_or_default(),
        "mcp_call" => {
            let server = input_str(input, "server").unwrap_or_default();
            let tool = input_str(input, "tool").unwrap_or_default();
            format!("{server} {tool}").trim().to_string()
        }
        "type_text" => input_str(input, "text").unwrap_or_default(),
        "open_app" => input_str(input, "name").unwrap_or_default(),
        "focus_window" => input_str(input, "title").unwrap_or_default(),
        _ => String::new(),
    }
}

fn label_for(tool: &str, target: &str) -> String {
    let short: String = target.chars().take(60).collect();
    match tool {
        "read_file" => format!("Reading {}", file_name_of(target)),
        "write_file" => format!("Writing {}", file_name_of(target)),
        "str_replace" => format!("Editing {}", file_name_of(target)),
        "list_dir" => format!("Listing {short}"),
        "search_files" => format!("Searching “{short}”"),
        "run_command" => format!("Running “{short}”"),
        "service_request" => format!("Service {short}"),
        "mcp_list_tools" => format!("Listing {short} tools"),
        "mcp_call" => format!("MCP {short}"),
        "screenshot" => "Looking at the screen".into(),
        "mouse_move" => format!("Moving mouse to ({short})"),
        "mouse_click" => format!("Clicking at ({short})"),
        "type_text" => format!("Typing “{short}”"),
        "press_key" => format!("Pressing {short}"),
        "scroll" => format!("Scrolling at ({short})"),
        "open_app" => format!("Opening {short}"),
        "focus_window" => format!("Focusing “{short}”"),
        other => format!("{other} {short}"),
    }
}

/// (ok, ui summary, model feedback, optional screenshot frame)
type ToolOutcome = (bool, String, String, Option<(String, u32, u32)>);

fn coord(input: &serde_json::Value, key: &str) -> Option<f64> {
    input.get(key).and_then(|v| v.as_f64())
}

/// Normalize 0..1000 like Computer Use (shared clamp from the cu controller).
fn clamp01k(v: f64) -> f64 {
    super::cu::controller::clamp_norm(v)
}

async fn execute_tool<E: Fn(serde_json::Value) + Send + Sync>(
    app: &AppHandle,
    emit: &E,
    root: &Option<String>,
    call: &ToolCall,
    approvals: &Arc<Mutex<HashMap<String, bool>>>,
    flag: &Arc<AtomicBool>,
    policy: &mut super::cu::policy::SessionPolicy,
    desktop: &mut Option<super::cu::AnyController>,
    read_set: &mut HashSet<String>,
    mirror: &mut Option<super::telegram::PhoneMirror>,
    auto_approve: bool,
) -> ToolOutcome {
    // --- Desktop control tools --------------------------------------------
    if is_desktop_tool(call.name.as_str()) {
        return execute_desktop_tool(app, emit, call, approvals, flag, policy, desktop, mirror, auto_approve).await;
    }

    // Workspace tools need an open folder.
    let Some(root) = root.clone() else {
        return (
            false,
            "No workspace open".into(),
            "ERROR: no workspace folder is open, so file and command tools are unavailable."
                .into(),
            None,
        );
    };
    let (ok, summary, feedback) = {
        let state = app.state::<super::AppState>();
        execute_workspace_tool(emit, &root, call, approvals, flag, read_set, state.inner(), mirror, auto_approve).await
    };
    (ok, summary, feedback, None)
}

async fn execute_workspace_tool<E: Fn(serde_json::Value) + Send + Sync>(
    emit: &E,
    root: &str,
    call: &ToolCall,
    approvals: &Arc<Mutex<HashMap<String, bool>>>,
    flag: &Arc<AtomicBool>,
    read_set: &mut HashSet<String>,
    mcp_state: &super::AppState,
    mirror: &mut Option<super::telegram::PhoneMirror>,
    auto_approve: bool,
) -> (bool, String, String) {
    let root_path = std::path::Path::new(root);

    match call.name.as_str() {
        "read_file" => {
            let path = input_str(&call.input, "path").unwrap_or_default();
            if path.trim().is_empty() {
                return (false, "Missing path".into(), "ERROR: read_file needs a path.".into());
            }
            let full = resolve(root_path, &path);
            match tokio::fs::read_to_string(&full).await {
                Ok(content) => {
                    // Read-before-edit policy: surgical edits require a fresh
                    // read of the same resolved path earlier in this run.
                    read_set.insert(display_key(&full));
                    let chars = content.chars().count();
                    let (fed, truncated_note) = truncate_chars(&content, TOOL_RESULT_CHAR_LIMIT);
                    let note = if truncated_note {
                        format!("\n… (truncated — file has {chars} characters)")
                    } else {
                        String::new()
                    };
                    (true, format!("Read {} ({chars} chars)", file_name_of(&path)), fed + &note)
                }
                Err(e) => {
                    let msg = friendly_io_error(&e);
                    (false, format!("Could not read {path}: {msg}"), format!("ERROR reading \"{path}\": {msg}"))
                }
            }
        }

        "list_dir" => {
            let raw = input_str(&call.input, "path").unwrap_or_else(|| ".".into());
            let dir = if raw.trim().is_empty() || raw == "." { root_path.to_path_buf() } else { resolve(root_path, &raw) };
            let mut lines = Vec::new();
            let mut budget = 400usize;
            list_lines(&dir, 0, 2, "", &mut budget, &mut lines);
            if lines.is_empty() {
                (false, "Directory not found or empty".into(), format!("ERROR: could not list \"{}\".", raw))
            } else {
                let listing = lines.join("\n");
                let fed = truncate_chars(&listing, TOOL_RESULT_CHAR_LIMIT).0;
                (true, format!("{} entries", lines.len()), fed)
            }
        }

        "search_files" => {
            let query = input_str(&call.input, "query").unwrap_or_default();
            if query.trim().is_empty() {
                return (false, "Missing query".into(), "ERROR: search_files needs a query.".into());
            }
            let root_clone = root.to_string();
            let needle = query.trim().to_lowercase();
            let hits = tauri::async_runtime::spawn_blocking(move || search_sync(&root_clone, &needle, 50, 1500))
                .await
                .unwrap_or_default();
            if hits.is_empty() {
                (true, format!("No matches for “{query}”"), format!("No matches for \"{query}\"."))
            } else {
                let summary = format!("{} match{} for “{query}”", hits.len(), if hits.len() == 1 { "" } else { "es" });
                (true, summary.clone(), hits.join("\n"))
            }
        }

        "str_replace" => {
            let path = input_str(&call.input, "path").unwrap_or_default();
            let old_str = input_str(&call.input, "old_str").unwrap_or_default();
            let new_str = input_str(&call.input, "new_str").unwrap_or_default();
            if path.trim().is_empty() {
                return (false, "Missing path".into(), "ERROR: str_replace needs a path, old_str, and new_str.".into());
            }
            if old_str.is_empty() {
                return (false, "Missing old_str".into(), "ERROR: str_replace needs old_str (the exact block to replace) and new_str.".into());
            }
            let full = resolve(root_path, &path);
            if !read_set.contains(&display_key(&full)) {
                return (
                    false,
                    "Read first".into(),
                    format!("ERROR: read \"{path}\" with read_file before editing it, then copy old_str exactly."),
                );
            }
            let content = match tokio::fs::read_to_string(&full).await {
                Ok(c) => c,
                Err(e) => {
                    let msg = friendly_io_error(&e);
                    return (false, format!("Could not read {path}: {msg}"), format!("ERROR reading \"{path}\": {msg}"));
                }
            };
            let updated = match apply_str_replace(&content, &old_str, &new_str) {
                Ok(u) => u,
                Err(e) => return (false, "No edit applied".into(), format!("ERROR: {e}")),
            };

            // Same review flow as write_file: the diff reaches the UI before
            // approval so the user sees exactly what will change. The diff
            // carries the approval id so the UI can answer it in place.
            let diff = simple_line_diff(&content, &updated);
            let (plus, minus) = count_diff_lines(&diff);
            let approval_id = uuid::Uuid::new_v4().to_string();
            emit(json!({
                "kind": "diff",
                "path": path,
                "change": "modified",
                "diffUnified": diff,
                "changeSummary": format!("+{plus} −{minus} lines"),
                "approvalId": approval_id,
            }));

            let decision = request_approval(
                emit, approvals, flag, mirror, &approval_id,
                "str_replace",
                format!("Edit {}", file_name_of(&path)),
                format!("Orin wants to apply a surgical edit to {path} (+{plus} −{minus})."),
                false,
                auto_approve,
            )
            .await;
            match decision {
                Some(true) => match tokio::fs::write(&full, &updated).await {
                    Ok(()) => (
                        true,
                        format!("Edited {} (+{plus} −{minus})", file_name_of(&path)),
                        format!("OK: applied surgical edit to {path}."),
                    ),
                    Err(e) => {
                        let msg = friendly_io_error(&e);
                        (false, format!("Could not write {path}: {msg}"), format!("ERROR writing \"{path}\": {msg}"))
                    }
                },
                Some(false) => (
                    false,
                    "Change declined".into(),
                    format!("SKIPPED: the user declined the edit to \"{path}\"."),
                ),
                None => (
                    false,
                    "Approval timed out".into(),
                    format!("SKIPPED: approval for \"{path}\" timed out."),
                ),
            }
        }

        "write_file" => {
            let path = input_str(&call.input, "path").unwrap_or_default();
            let content = input_str(&call.input, "content").unwrap_or_default();
            if path.trim().is_empty() {
                return (false, "Missing path".into(), "ERROR: write_file needs a path.".into());
            }
            let full = resolve(root_path, &path);
            let existed = full.exists();
            let old = tokio::fs::read_to_string(&full).await.unwrap_or_default();

            // The diff goes to the UI before approval so the user sees exactly
            // what will change while deciding. It carries the approval id so
            // the UI answers it on the diff card itself.
            let diff = simple_line_diff(&old, &content);
            let (plus, minus) = count_diff_lines(&diff);
            let approval_id = uuid::Uuid::new_v4().to_string();
            emit(json!({
                "kind": "diff",
                "path": path,
                "change": if existed { "modified" } else { "added" },
                "diffUnified": diff,
                "changeSummary": format!("+{plus} −{minus} lines"),
                "approvalId": approval_id,
            }));

            let decision = request_approval(
                emit, approvals, flag, mirror, &approval_id,
                "write_file",
                if existed { format!("Modify {}", file_name_of(&path)) } else { format!("Create {}", file_name_of(&path)) },
                format!("Orin wants to {} {}.", if existed { "modify" } else { "create" }, path),
                false,
                auto_approve,
            )
            .await;
            match decision {
                Some(true) => {
                    if let Some(parent) = full.parent() {
                        if let Err(e) = tokio::fs::create_dir_all(parent).await {
                            let msg = friendly_io_error(&e);
                            return (false, format!("Could not create folders for {path}: {msg}"), format!("ERROR: {msg}"));
                        }
                    }
                    match tokio::fs::write(&full, &content).await {
                        Ok(()) => (
                            true,
                            format!("Wrote {} (+{plus} −{minus})", file_name_of(&path)),
                            format!("OK: wrote {} to {}.", human_len(content.len()), path),
                        ),
                        Err(e) => {
                            let msg = friendly_io_error(&e);
                            (false, format!("Could not write {path}: {msg}"), format!("ERROR writing \"{path}\": {msg}"))
                        }
                    }
                }
                Some(false) => (
                    false,
                    "Change declined".into(),
                    format!("SKIPPED: the user declined changes to \"{path}\"."),
                ),
                None => (
                    false,
                    "Approval timed out".into(),
                    format!("SKIPPED: approval for \"{path}\" timed out."),
                ),
            }
        }

        "service_request" => {
            let service = input_str(&call.input, "service").unwrap_or_default();
            let method = input_str(&call.input, "method").unwrap_or_else(|| "GET".into());
            let path = input_str(&call.input, "path").unwrap_or_default();
            if service.trim().is_empty() || path.trim().is_empty() {
                return (
                    false,
                    "Missing service/path".into(),
                    "ERROR: service_request needs service (github|slack|notion), method, and path — e.g. service \"github\", method \"GET\", path \"/user\".".into(),
                );
            }
            // Writes leave the machine: same approval gate as file writes.
            if method.to_uppercase() != "GET" {
                let connector_label =
                    super::connectors::find(&service).map(|c| c.label).unwrap_or("service");
                let approval_id = uuid::Uuid::new_v4().to_string();
                match request_approval(
                    emit, approvals, flag, mirror, &approval_id,
                    "service_request",
                    format!("{connector_label} {} {}", method.to_uppercase(), path),
                    format!("Orin wants to call {connector_label} ({} {}) — credentials stay server-side.", method.to_uppercase(), path),
                    true,
                    auto_approve,
                )
                .await
                {
                    Some(true) => {}
                    Some(false) => {
                        return (
                            false,
                            "Service call declined".into(),
                            "SKIPPED: the user declined this service call.".into(),
                        )
                    }
                    None => {
                        return (
                            false,
                            "Approval timed out".into(),
                            "SKIPPED: approval for this service call timed out.".into(),
                        )
                    }
                }
            }
            let body = call.input.get("body").cloned();
            match super::connectors::service_request(&service, &method.to_uppercase(), &path, body.as_ref())
                .await
            {
                Ok((summary, feedback)) => (true, summary, feedback),
                Err(feedback) => (false, "Service call failed".into(), feedback),
            }
        }

        "mcp_list_tools" => {
            let server = input_str(&call.input, "server").unwrap_or_default();
            if server.trim().is_empty() {
                return (false, "Missing server".into(), "ERROR: mcp_list_tools needs a server id (see Settings → Connections → MCP).".into());
            }
            match super::mcp::agent_list_tools(mcp_state, &server).await {
                Ok((summary, feedback)) => (true, summary, feedback),
                Err(feedback) => (false, "MCP list failed".into(), feedback),
            }
        }

        "mcp_call" => {
            let server = input_str(&call.input, "server").unwrap_or_default();
            let tool = input_str(&call.input, "tool").unwrap_or_default();
            let arguments =
                call.input.get("arguments").cloned().unwrap_or(serde_json::json!({}));
            if server.trim().is_empty() || tool.trim().is_empty() {
                return (false, "Missing server/tool".into(), "ERROR: mcp_call needs server and tool — discover them with mcp_list_tools first.".into());
            }
            // MCP tools act on the outside world (send mail, move files): always ask.
            let approval_id = uuid::Uuid::new_v4().to_string();
            match request_approval(
                emit, approvals, flag, mirror, &approval_id,
                "mcp_call",
                format!("MCP {server} → {tool}"),
                format!("Orin wants to call {tool} on {server}. Keys stay server-side."),
                true,
                auto_approve,
            )
            .await
            {
                Some(true) => match super::mcp::agent_call(mcp_state, &server, &tool, &arguments).await {
                    Ok((summary, feedback)) => (true, summary, feedback),
                    Err(feedback) => (false, "MCP call failed".into(), feedback),
                },
                Some(false) => (false, "MCP call declined".into(), "SKIPPED: the user declined this MCP call.".into()),
                None => (false, "Approval timed out".into(), "SKIPPED: approval for this MCP call timed out.".into()),
            }
        }

        "run_command" => {
            let command = input_str(&call.input, "command").unwrap_or_default();
            if command.trim().is_empty() {
                return (false, "Missing command".into(), "ERROR: run_command needs a command.".into());
            }
            let approval_id = uuid::Uuid::new_v4().to_string();
            match request_approval(
                emit, approvals, flag, mirror, &approval_id,
                "run_command",
                "Run shell command".into(),
                command.chars().take(300).collect::<String>(),
                true,
                auto_approve,
            )
            .await
            {
                Some(true) => {
                    let (program, args): (&str, Vec<&str>) = if cfg!(windows) {
                        ("cmd", vec!["/C", &command])
                    } else {
                        ("sh", vec!["-c", &command])
                    };
                    let mut cmd = tokio::process::Command::new(program);
                    cmd.args(&args).current_dir(root_path);
                    #[cfg(windows)]
                    {
                        // CREATE_NO_WINDOW — keeps helper shells from flashing consoles.
                        use std::os::windows::process::CommandExt as _;
                        cmd.creation_flags(0x0800_0000);
                    }
                    let spawned = cmd.output();
                    match tokio::time::timeout(Duration::from_secs(COMMAND_TIMEOUT_SECS), spawned).await {
                        Ok(Ok(output)) => {
                            let mut combined = String::new();
                            combined.push_str(&String::from_utf8_lossy(&output.stdout));
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            if !stderr.trim().is_empty() {
                                if !combined.is_empty() {
                                    combined.push('\n');
                                }
                                combined.push_str(&stderr);
                            }
                            let exit_note = match output.status.code() {
                                Some(0) => String::new(),
                                Some(code) => format!("\n[exit code {code}]"),
                                None => "\n[terminated by signal]".into(),
                            };
                            let (fed, was_truncated) = truncate_chars(combined.trim(), 8000);
                            let note = if was_truncated { "\n… (output truncated)" } else { "" };
                            (
                                output.status.success(),
                                if output.status.success() { "Command finished".into() } else { format!("Command failed{}", exit_note.replace('\n', " ")) },
                                format!("{fed}{note}{exit_note}"),
                            )
                        }
                        Ok(Err(e)) => {
                            let msg = friendly_io_error(&e);
                            (false, format!("Could not run the command: {msg}"), format!("ERROR: {msg}"))
                        }
                        Err(_) => (
                            false,
                            format!("Command timed out after {COMMAND_TIMEOUT_SECS}s"),
                            format!("ERROR: command exceeded the {COMMAND_TIMEOUT_SECS}s limit and was stopped."),
                        ),
                    }
                }
                Some(false) => (false, "Command declined".into(), "SKIPPED: the user declined to run this command.".into()),
                None => (false, "Approval timed out".into(), "SKIPPED: approval for this command timed out.".into()),
            }
        }

        other => (false, "Unknown tool".into(), format!("ERROR: unknown tool \"{other}\".")),
    }
}

// ---------------------------------------------------------------------------
// Desktop control (Computer Use providers, driven from the agent loop)
// ---------------------------------------------------------------------------

async fn execute_desktop_tool<E: Fn(serde_json::Value) + Send + Sync>(
    _app: &AppHandle,
    emit: &E,
    call: &ToolCall,
    approvals: &Arc<Mutex<HashMap<String, bool>>>,
    flag: &Arc<AtomicBool>,
    policy: &mut super::cu::policy::SessionPolicy,
    desktop: &mut Option<super::cu::AnyController>,
    mirror: &mut Option<super::telegram::PhoneMirror>,
    auto_approve: bool,
) -> ToolOutcome {
    #[cfg(not(windows))]
    {
        let _ = (policy, desktop);
        return (
            false,
            "Desktop control unavailable".into(),
            "ERROR: desktop control is only available on Windows.".into(),
            None,
        );
    }

    #[cfg(windows)]
    {
        use super::cu::policy::Decision;

        // Lazy-init the real-desktop controller on first use.
        if desktop.is_none() {
            match super::cu::create_controller("windows") {
                Ok(c) => *desktop = Some(c),
                Err(error) => {
                    return (false, "Could not start desktop control".into(), format!("ERROR: {error}"), None)
                }
            }
        }
        let controller = desktop.as_mut().expect("desktop initialized above");

        // Safety gate — same session policy as Computer Use: one approval
        // unlocks ordinary input for the rest of the run; apps ask per target.
        let action_kind = match call.name.as_str() {
            "screenshot" => String::new(), // read-only observation, never gated
            "mouse_move" => "move".into(),
            "mouse_click" => "click".into(),
            "type_text" => "type".into(),
            "press_key" => "key".into(),
            "scroll" => "scroll".into(),
            "open_app" => "open_app".into(),
            "focus_window" => "focus_window".into(),
            other => other.to_string(),
        };
        let gate_target = tool_target(call.name.as_str(), &call.input);
        if !action_kind.is_empty() {
            if let Decision::Ask(need) = policy.decide(&action_kind, &gate_target) {
                let approval_id = uuid::Uuid::new_v4().to_string();
                match request_approval(
                    emit, approvals, flag, mirror, &approval_id,
                    &call.name, need.title, need.detail, need.destructive,
                    auto_approve,
                )
                .await
                {
                    Some(true) => policy.grant(&action_kind, &gate_target),
                    Some(false) => {
                        return (
                            false,
                            "Control declined".into(),
                            format!("SKIPPED: the user declined to let you {}.", action_kind),
                            None,
                        )
                    }
                    None => {
                        return (
                            false,
                            "Approval timed out".into(),
                            "SKIPPED: desktop-control approval timed out.".into(),
                            None,
                        )
                    }
                }
            }
        }

        let run = |controller: &mut super::cu::AnyController| -> Result<String, String> {
            Ok(match call.name.as_str() {
                "screenshot" => String::new(),
                "mouse_move" => {
                    let x = coord(&call.input, "x").unwrap_or(500.0);
                    let y = coord(&call.input, "y").unwrap_or(500.0);
                    controller.move_mouse(clamp01k(x), clamp01k(y))?;
                    format!("moved to ({}, {})", clamp01k(x) as i32, clamp01k(y) as i32)
                }
                "mouse_click" => {
                    let x = coord(&call.input, "x").unwrap_or(500.0);
                    let y = coord(&call.input, "y").unwrap_or(500.0);
                    let button = input_str(&call.input, "button").unwrap_or_else(|| "left".into());
                    controller.move_mouse(clamp01k(x), clamp01k(y))?;
                    controller.click(&button)?;
                    format!("{button} click at ({}, {})", clamp01k(x) as i32, clamp01k(y) as i32)
                }
                "type_text" => {
                    let text = input_str(&call.input, "text").unwrap_or_default();
                    if text.is_empty() {
                        return Err("type_text needs text.".into());
                    }
                    controller.type_text(&text)?;
                    format!("typed {} chars", text.chars().count())
                }
                "press_key" => {
                    let key = input_str(&call.input, "key")
                        .or_else(|| input_str(&call.input, "keys"))
                        .unwrap_or_default();
                    if key.is_empty() {
                        return Err("press_key needs a key like \"enter\" or \"ctrl+s\".".into());
                    }
                    controller.press_key(&key)?;
                    format!("pressed {key}")
                }
                "scroll" => {
                    let x = coord(&call.input, "x").unwrap_or(500.0);
                    let y = coord(&call.input, "y").unwrap_or(500.0);
                    let amount = coord(&call.input, "amount").unwrap_or(3.0).clamp(-20.0, 20.0) as i32;
                    controller.scroll(clamp01k(x), clamp01k(y), amount)?;
                    format!("scrolled {amount}")
                }
                "open_app" => {
                    let name = input_str(&call.input, "name").unwrap_or_default();
                    if name.is_empty() {
                        return Err("open_app needs an app name.".into());
                    }
                    controller.open_app(&name)?;
                    format!("opened {name}")
                }
                "focus_window" => {
                    let title = input_str(&call.input, "title").unwrap_or_default();
                    if title.is_empty() {
                        return Err("focus_window needs a window title.".into());
                    }
                    controller.focus_window(&title)?;
                    format!("focused window matching \"{title}\"")
                }
                other => return Err(format!("unknown desktop tool \"{other}\".")),
            })
        };

        // Screenshot runs first so a failed capture never blocks plain input.
        if call.name == "screenshot" {
            return match controller.screenshot_jpeg().await {
                Ok((jpeg, width, height)) => {
                    use base64::Engine as _;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(jpeg);
                    (
                        true,
                        format!("Captured {width}×{height}"),
                        format!("OK: captured the screen ({width}x{height}); it is attached as an image."),
                        Some((b64, width, height)),
                    )
                }
                Err(error) => (false, "Capture failed".into(), format!("ERROR: {error}"), None),
            };
        }

        match run(controller) {
            Ok(detail) => (true, capitalize(&detail), format!("OK: {detail}."), None),
            Err(error) => (false, "Action failed".into(), format!("ERROR: {error}"), None),
        }
    }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Poll `state.approvals` until `approval_respond` lands a decision — or the
/// linked phone answers first via the Orin Code bot. Either side wins; a
/// remote decision is parked in the shared map like a local one.
async fn wait_approval(
    approvals: &Arc<Mutex<HashMap<String, bool>>>,
    id: &str,
    flag: &Arc<AtomicBool>,
    mirror: Option<&super::telegram::PhoneMirror>,
) -> Option<bool> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(APPROVAL_TIMEOUT_SECS);
    let mut ticks = 0u32;
    loop {
        if let Ok(mut map) = approvals.lock() {
            if let Some(decision) = map.remove(id) {
                return Some(decision);
            }
        }
        if flag.load(Ordering::Relaxed) {
            return None;
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        ticks += 1;
        // Phone check every ~3 s; foreign decisions are parked for their waits.
        if ticks % 20 == 0 {
            if let Some(m) = mirror {
                let batch = super::telegram::mirror_poll(m).await;
                if let Some(approved) = super::telegram::mirror_match(&batch, id) {
                    return Some(approved);
                }
                for (aid, approved) in batch {
                    if let Ok(mut map) = approvals.lock() {
                        map.insert(aid, approved);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// One gate for every mutating tool: emit the approval-request event, mirror
/// it to the linked phone (best-effort — a dead link disables mirroring for
/// the rest of the run), then wait for either side to decide.
///
/// Phone-confirmed runs (`auto_approve`) resolve immediately: the user tapped
/// Run on Telegram for THIS task, so each approval is pre-granted — still
/// emitted to the UI and trajectory log for a full audit trail.
async fn request_approval<E: Fn(serde_json::Value) + Send + Sync>(
    emit: &E,
    approvals: &Arc<Mutex<HashMap<String, bool>>>,
    flag: &Arc<AtomicBool>,
    mirror: &mut Option<super::telegram::PhoneMirror>,
    id: &str,
    tool: &str,
    title: String,
    detail: String,
    destructive: bool,
    auto_approve: bool,
) -> Option<bool> {
    emit(json!({
        "kind": "approval-request",
        "approvalId": id,
        "tool": tool,
        "title": title,
        "detail": detail,
        "destructive": destructive,
        "auto": auto_approve,
    }));
    if auto_approve {
        return Some(true);
    }
    if let Some(m) = mirror.as_ref() {
        if !super::telegram::mirror_push(m, id, tool, &title, &detail).await {
            *mirror = None;
        }
    }
    wait_approval(approvals, id, flag, mirror.as_ref()).await
}

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

/// Identity of a tool call for the repeat breaker: name + exact input JSON.
/// Two calls are "the same" only if every byte of input matches.
fn call_sig(call: &ToolCall) -> String {
    format!("{}:{}", call.name, call.input)
}

/// Extract every well-formed `<tool_call>{...}</tool_call>` block. Malformed
/// JSON is skipped rather than failing the whole turn.
fn parse_tool_calls(text: &str) -> Vec<ToolCall> {
    const OPEN: &str = "<tool_call>";
    const CLOSE: &str = "</tool_call>";
    let mut calls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let after_open = &rest[start + OPEN.len()..];
        let Some(end) = after_open.find(CLOSE) else { break };
        let body = after_open[..end]
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        if let Ok(call) = serde_json::from_str::<ToolCall>(body) {
            if !call.name.trim().is_empty() {
                calls.push(call);
            }
        }
        rest = &after_open[end + CLOSE.len()..];
    }
    calls
}

fn strip_tool_blocks(text: &str) -> String {
    const OPEN: &str = "<tool_call>";
    const CLOSE: &str = "</tool_call>";
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + OPEN.len()..];
        match after_open.find(CLOSE) {
            Some(end) => rest = &after_open[end + CLOSE.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn plan_from(request: &str, first_reply: &str) -> Vec<String> {
    let checklist: Vec<String> = first_reply
        .lines()
        .map(str::trim_start)
        .filter(|l| l.starts_with("- [ ]") || l.starts_with("- [x]"))
        .map(|l| {
            l.trim_start_matches("- [ ]")
                .trim_start_matches("- [x]")
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .take(8)
        .collect();
    if !checklist.is_empty() {
        return checklist;
    }
    let ask: String = request.split_whitespace().take(14).collect::<Vec<_>>().join(" ");
    vec![
        format!("Understand the request: {ask}"),
        "Inspect the relevant parts of the workspace".into(),
        "Do the work and report the outcome".into(),
    ]
}

fn summarize(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "Done.".into();
    }
    let mut end = 320usize;
    if trimmed.chars().count() <= end {
        return trimmed.to_string();
    }
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &trimmed[..end])
}

// ---------------------------------------------------------------------------
// Small filesystem helpers (kept local so fs.rs stays untouched)
// ---------------------------------------------------------------------------

fn resolve(root: &std::path::Path, path: &str) -> std::path::PathBuf {
    let candidate = std::path::Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    }
}

fn ignored_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "target" | "dist" | "build" | ".next" | ".venv" | "__pycache__" | ".vs" | "out"
    )
}

const BINARY_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "exe", "dll", "so", "dylib", "zip", "gz",
    "tar", "7z", "rar", "pdf", "woff", "woff2", "ttf", "otf", "mp3", "mp4", "mov", "avi", "mkv",
    "wasm", "pdb", "lib", "a", "class", "jar",
];

fn list_lines(dir: &std::path::Path, depth: u32, max_depth: u32, indent: &str, budget: &mut usize, out: &mut Vec<String>) {
    if depth > max_depth || *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if *budget == 0 {
            out.push(format!("{indent}…"));
            return;
        }
        *budget -= 1;
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if ignored_dir(&name) {
                continue;
            }
            out.push(format!("{indent}{name}/"));
            list_lines(&entry.path(), depth + 1, max_depth, &format!("{indent}  "), budget, out);
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(format!("{indent}{name} ({})", human_len(size as usize)));
        }
    }
}

fn search_sync(root: &str, needle: &str, max_hits: usize, max_files: usize) -> Vec<String> {
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![std::path::PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        if hits.len() >= max_hits || scanned >= max_files {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !ignored_dir(&name) {
                    stack.push(path);
                }
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
            if BINARY_EXT.contains(&ext.as_str()) {
                continue;
            }
            let Ok(content) = std::fs::read(&path) else { continue };
            if content.len() > 1024 * 1024 {
                continue;
            }
            scanned += 1;
            if scanned >= max_files && hits.is_empty() {
                break;
            }
            let display = path.to_string_lossy().replace('\\', "/");
            for (index, line) in String::from_utf8_lossy(&content).lines().enumerate() {
                if line.to_lowercase().contains(needle) {
                    hits.push(format!(
                        "{}:{}: {}",
                        display,
                        index + 1,
                        line.trim().chars().take(200).collect::<String>()
                    ));
                    break; // one hit per file keeps results diverse
                }
                if hits.len() >= max_hits {
                    break;
                }
            }
            if hits.len() >= max_hits {
                break;
            }
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// Inline line diff (no external crates)
// ---------------------------------------------------------------------------

fn split_lines(s: &str) -> Vec<&str> {
    s.lines().collect()
}

/// A compact unified-style diff built from common prefix/suffix lines:
/// everything between them is shown as `-` / `+` with three context lines
/// around the change. Good enough for review UIs without a real LCS engine.
fn simple_line_diff(old: &str, new: &str) -> String {
    let a = split_lines(old);
    let b = split_lines(new);

    let mut prefix = 0usize;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < a.len() - prefix && suffix < b.len() - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }

    const CONTEXT: usize = 3;
    let ctx_start = prefix.saturating_sub(CONTEXT);
    let del_start = ctx_start;
    let del_end = (a.len() - suffix).min(a.len());
    let add_start = ctx_start;
    let add_end = (b.len() - suffix).min(b.len());
    let tail_start_a = del_end;
    let tail_end_a = (tail_start_a + CONTEXT).min(a.len());

    let removed = &a[del_start.max(prefix)..del_end];
    let added = &b[add_start.max(prefix)..add_end];

    if removed.is_empty() && added.is_empty() {
        return "(no textual changes)".into();
    }

    let mut out = String::new();
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        del_start + 1,
        del_end - del_start,
        add_start + 1,
        add_end - add_start
    ));
    for line in &a[ctx_start..prefix.min(a.len())] {
        out.push(' ');
        out.push_str(line);
        out.push('\n');
    }
    for line in removed {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in added {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    for line in &a[tail_start_a..tail_end_a] {
        out.push(' ');
        out.push_str(line);
        out.push('\n');
    }

    if out.len() > 16_000 {
        let mut cut = 16_000;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n… (diff truncated)");
    }
    out
}

fn count_diff_lines(diff: &str) -> (usize, usize) {
    let plus = diff.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
    let minus = diff.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
    (plus, minus)
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

fn truncate_chars(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_string(), false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

fn human_len(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn friendly_io_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "the file does not exist".into(),
        std::io::ErrorKind::PermissionDenied => "access was denied".into(),
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn desktop_tools_gate_on_availability() {
        // On any build, workspace tools need an open folder.
        assert!(!is_supported_tool("read_file", false, false));
        assert!(is_supported_tool("read_file", true, false));
        // Desktop tools ride on the real-machine capability, not the workspace.
        assert!(is_supported_tool("mouse_click", false, true));
        assert!(is_supported_tool("screenshot", false, true));
        assert!(!is_supported_tool("mouse_click", false, false));
    }

    #[test]
    fn desktop_targets_and_labels() {
        assert_eq!(tool_target("type_text", &json!({"text": "hello world"})), "hello world");
        assert_eq!(tool_target("open_app", &json!({"name": "notepad"})), "notepad");
        assert_eq!(tool_target("mouse_click", &json!({"x": 10, "y": 20})), "");
        assert_eq!(label_for("screenshot", ""), "Looking at the screen");
        assert_eq!(label_for("press_key", "ctrl+s"), "Pressing ctrl+s");
        assert!(is_supported_tool("str_replace", true, false));
        assert!(!is_supported_tool("str_replace", false, false));
        assert_eq!(tool_target("str_replace", &json!({"path": "src/main.rs"})), "src/main.rs");
        assert_eq!(label_for("str_replace", "src/main.rs"), "Editing main.rs");
    }

    #[test]
    fn coords_clamp_to_normalized_range() {
        assert_eq!(clamp01k(-50.0), 0.0);
        assert_eq!(clamp01k(500.0), 500.0);
        assert_eq!(clamp01k(5000.0), 1000.0);
        assert_eq!(coord(&json!({"x": 12.5}), "x"), Some(12.5));
        assert_eq!(coord(&json!({"y": "7"}), "y"), None); // numbers only
    }

    #[test]
    fn str_replace_exact_ambiguous_and_missing() {
        let content = "line one\nline two\nline three\n";
        let updated = apply_str_replace(content, "line two\n", "LINE TWO\n").unwrap();
        assert_eq!(updated, "line one\nLINE TWO\nline three\n");
        let err = apply_str_replace("a\nb\na\n", "a\n", "z\n").unwrap_err();
        assert!(err.contains("2 places"), "unexpected: {err}");
        let err = apply_str_replace(content, "nope\n", "z\n").unwrap_err();
        assert!(err.contains("not found"), "unexpected: {err}");
        assert!(apply_str_replace(content, "", "z").is_err());
    }

    #[test]
    fn str_replace_tolerates_crlf_anchors() {
        let content = "first\r\nsecond\r\nthird\r\n";
        let updated = apply_str_replace(content, "second\n", "SECOND\n").unwrap();
        assert_eq!(updated, "first\r\nSECOND\r\nthird\r\n");
    }

    fn tool_call(name: &str, input: serde_json::Value) -> ToolCall {
        ToolCall { name: name.into(), input }
    }

    #[test]
    fn repeat_breaker_spots_identical_calls() {
        let a = tool_call("read_file", json!({ "path": "x.rs" }));
        let b = tool_call("read_file", json!({ "path": "x.rs" }));
        let c = tool_call("read_file", json!({ "path": "y.rs" }));
        let d = tool_call("list_dir", json!({ "path": "x.rs" }));
        assert_eq!(call_sig(&a), call_sig(&b));
        assert_ne!(call_sig(&a), call_sig(&c));
        assert_ne!(call_sig(&a), call_sig(&d));
    }

    #[test]
    fn service_tool_is_registered_and_labeled() {
        assert!(is_supported_tool("service_request", true, false));
        assert!(!is_supported_tool("service_request", false, false));
        assert_eq!(
            tool_target("service_request", &json!({ "service": "github", "path": "/user" })),
            "github /user"
        );
        assert_eq!(label_for("service_request", "github /user"), "Service github /user");
        assert!(is_supported_tool("mcp_list_tools", true, false));
        assert!(is_supported_tool("mcp_call", true, false));
        assert!(!is_supported_tool("mcp_call", false, false));
        assert_eq!(tool_target("mcp_call", &json!({ "server": "gmail", "tool": "send" })), "gmail send");
        assert_eq!(label_for("mcp_call", "gmail send"), "MCP gmail send");
    }
}
