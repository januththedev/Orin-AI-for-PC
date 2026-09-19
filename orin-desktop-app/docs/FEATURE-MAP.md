# Orin Code — full feature map (verify against your needs)

E2E stamp (2026-09-18, commit `e064c11`): `cargo test` **15/15 pass** ·
`tsc --noEmit` **pass** · `oxlint` **0 errors** (14 pre-existing warnings,
none in new code) · `vite build` **pass** · bridge cross-check **39/39
commands** Rust↔TS match · tree clean, pushed.

Architecture in one line: `ui/` (React 19 + TS, Claude-style) talks only
through typed `invoke`/`listen` to `src-tauri/src/bridge/` (Rust core that
owns network, files, terminals, keys). Contract: `docs/BRIDGE.md`.

## 1. Entry gates — `ui/src/App.tsx`, `features/welcome/WelcomePage.tsx`

- Boot checks `authStatus` + **any** stored provider key (`providersList` →
  every `keyRequired` preset + legacy `openai_compat` slot) + dismissed flag.
- Three doors, all land in the same app: **Sign in with Orin AI** (browser
  device flow, approval code) · **Connect your own API key** (provider
  dropdown from live `providersList`, saves key, auto-points composer at
  first fetched model) · **Explore offline** (mock responder).
- After entering, both directions stay open: Settings → Account (sign in
  later) and Settings → Models (add keys later). Workflow is never blocked.

## 2. Identity — `src-tauri/src/bridge/auth.rs`, `stores/authStore.ts`

- `Session { uid, name, email, phone, authKind }`. Old stored sessions
  default to `"firebase"` and keep working.
- Password `auth_login`/`auth_register` → Firebase custom-token exchange
  (unchanged legacy path).
- Browser device flow `auth_device_start` (opens orinai.org, shows user
  code) → `auth_device_wait` polls `POST /api/auth/device`:
  Clerk approval `{ auth_kind:"clerk", session_token, refresh_token?,
  user }` stored directly; Firebase `custom_token` approval uses the old
  exchange. Same session/keyring slots either way.
- `ensure_id_token`: live token cached in memory (~1 h, refresh <10 min
  remaining). Clerk refreshes via `POST /api/auth/clerk/refresh`;
  Firebase via Google securetoken. Signed-out = normal, degrades to BYOK.
- Secrets: refresh/session tokens in OS keyring (`orin-ai` service);
  live token never leaves Rust. Server contract: `docs/CLERK-BRIDGE.md`.

## 3. Provider router (embedded OmniRoute) — `bridge/presets.rs`, `headers`

- 17 presets: OpenRouter, Groq, DeepSeek, Mistral, Together, Fireworks, xAI,
  OpenAI, Anthropic (native), Gemini, Cohere, Perplexity, Ollama, LM Studio,
  vLLM, LiteLLM, Custom. Each carries base URL + key policy + docs URL.
- `preset_headers()`: built-in headers (OpenRouter `HTTP-Referer`/`X-Title:
  Orin Code`) attached by the single streaming engine — user never writes
  headers, names, or links.
- `resolve_base_url`: per-preset override `providers/{id}/baseUrl` → legacy
  custom → built-in default.
- Key vault: `provider_set_key`/`provider_has_key` per preset in OS keyring;
  service name kept `orin-ai` so existing keys survive the rename.
- One dispatch in `ai_impl::generate`: `anthropic/…` native, `mock/…`
  offline typewriter, `orin/…` cloud, else OpenAI-compatible streaming.

## 4. Models, automatic — `bridge/models_fetch.rs`, `ai_impl::catalog`

- `models_fetch(preset)`: `GET {base}/models` (+headers, bearer whenever a
  key exists) for 15 presets; Ollama `/api/tags`; Anthropic curated
  (no list API — catalog slice + flagship fallback). Friendly errors
  ("Add an API key first", "needs a base URL").
- `models_list`: built-in catalog (mock offline, Claude Sonnets, free
  OpenRouter picks, Groq, Gemini) + Orin Cloud models only when signed in.
- UI: Settings → Models lists **all** presets with Get-key link, key
  status, per-provider Models refresh + live count; welcome BYOK +
  composer picker consume the same source. Paste key → models appear.

## 5. Chat + agent harness — `features/chat/*`, `bridge/agent.rs`

- ChatPage + Composer (model menu, mode pills, streaming via
  `ai-chunk`/`ai-done`/`ai-error`), HistorySearch, per-project
  instructions.
- Agent loop (works on every provider, no native tool-use needed):
  `<tool_call>{name,input}</tool_call>` protocol, 12 iterations, screenshot
  frames fed back as images.
- Tools: `read_file`, `list_dir`, `search_files`, **`str_replace`** (exact
  one-match surgical edit, CRLF-tolerant, **read-before-edit enforced**),
  `write_file`, `run_command` (120 s, no console flash), + 8
  desktop-control tools behind the Computer-Use policy gate.
- Harness guarantees: diff preview (`diff` event, unified) **before**
  every file approval; `approval-request` with 10-min timeout for
  write/str_replace/run/desktop; **trajectory log**
  `{workspace}/.orin-trajectory/{run_id}.jsonl` (run_start, assistant,
  tool_start/end, done/error) for resume/fork/replay; **plan mode**
  forces read-only + step plan.
- UI surfaces: plan steps, tool-start/end, step rows, assistant messages,
  ArtifactViewer diffs with Apply/Reject.

## 6. IDE — `features/ide/` (explorer, Monaco, terminal, AI panel)

- FileExplorer, Monaco editor, ConPTY TerminalPane (ANSI-stripped),
  AiPanel side chat. `fs_*` commands + `git_status` + `search_workspace`
  power it, all fenced to the workspace root.

## 7. Computer Use — `bridge/cu/`, `features/computer/`

- Windows provider (GDI capture + SendInput) + virtual demo provider,
  session policy (screenshot free, input asks once per run, apps per
  target), `cu-frame` JPEG stream, permissions UI. Agent loop can drive it
  with screenshot-verify discipline.

## 8. Projects / Artifacts / Home / Settings / Connections

- Projects (open folder, per-project instructions + model), Artifacts
  gallery with preview + time-ago, Home dashboard, Customize, Skills,
  command palette, history search, cloud sync
  (`sync_pull/push`, opt-out, 512 KB cap).
- Connections (Settings): GitHub / Slack / Notion credentials in OS
  keyring slots with live Test validation and status pills; the agent's
  `service_request` tool calls them with tokens injected server-side
  (GET free, writes ask approval). MCP servers (Gmail/Drive/OneDrive via
  hosted Streamable-HTTP endpoints — no Google Cloud/Azure setup) with
  handshake + tool-count test; the agent self-discovers via
  `mcp_list_tools` and calls via approval-gated `mcp_call`. Telegram bot
  token the same way plus test-send. Google Drive stays honestly
  OAuth-gated.

## 9. Branding — Orin Code + amber

- `tauri.conf.json` (`Orin Code`, `ai.orin.code`), Cargo `orin-code`,
  installer `Orin-Code-Setup`/`orin-code.exe`, window/HTML/Layout titles,
  welcome header, README, `X-Title: Orin Code`, agent persona.
- Amber system in `ui/src/design/tokens.css` (`--accent #e08a3c`,
  soft/line/hover variants) + OrinMark bolt with breathe/flicker/ring/
  glow-pulse/sweep states while streaming.

## 10. Your needs → status → where to verify

| # | Need | Status | Verify |
|---|---|---|---|
| 1 | Repo latest | ✅ synced+pushed (`git log`, clean tree) | `git log --oneline -10`, `git status` |
| 2 | Desktop folder explained | ✅ `orin-desktop-app/` = Tauri app | folder + `README.md` |
| 3 | Claude-like editor UI | ✅ chat-first, artifacts, markdown | run `npm run app:dev` |
| 4 | OmniRoute multi-API + key handling | ✅ 17 presets, OS vault | Settings → Models |
| 5 | DeepSeek-harness output control | ✅ str_replace, trajectory, approvals, plan | `cargo test bridge::agent` (5/5), `.orin-trajectory/` after a run |
| 6 | Named Orin Code, amber lighting | ✅ rename + tokens + bolt glow | title bar, `tokens.css` |
| 7 | Auto-fetch all models | ✅ per-provider live + curated | Models button per provider |
| 8 | Built-in headers/endpoints/docs | ✅ `preset_headers`, `docsUrl` Get-key links | Settings → Models |
| 9a | Sign in → no keys | ✅ device flow + cloud models | Welcome → Sign in |
| 9b | BYOK → enter, add more later | ✅ any-key gate + Settings anytime | Welcome → BYOK, Settings → Models/Account |
| 10 | Clerk | 🟡 PC ready (`552ce4c`), needs server | `docs/CLERK-BRIDGE.md` §0–§4 |

## 11. Needs-you-action (not code defects)

- Clerk app keys + 3 orinai.org endpoints (`CLERK-BRIDGE.md`).
- Firebase stays as fallback until then — deleting it is a one-commit
  follow-up once Clerk is live.
