# Orin Code — desktop workspace

Powerful, lightweight AI coding workspace: a **native Rust core** (Tauri v2) driving a **React 19 + TypeScript** UI inside the OS WebView2 runtime. No Electron — the installer is ~15 MB, cold start is sub-400 ms, and every network call, file operation, terminal, and Computer-Use action runs in Rust workers.

## Architecture

```
src-tauri/   Rust core: AI providers (Anthropic / OpenAI-compatible / offline mock),
             agent tool loop with approval gates, ConPTY terminals, SQLite persistence,
             Computer Use (Windows provider: GDI capture + SendInput; Virtual provider for safe demos),
             orinai.org accounts — sign-in, quota-metered Orin Cloud models, cross-device sync
ui/          React UI: shell (custom title bar + nav rail), chat, projects, artifacts,
             IDE (explorer, Monaco, terminal, AI panel), settings suite, command surfaces
docs/        BRIDGE.md — the command/event contract both sides implement
```

The renderer never touches IO itself; it invokes typed commands and listens to events (`docs/BRIDGE.md`).

## Develop

```powershell
cd orin-desktop-app
npm install

# UI only, in a plain browser (mock backend answers every command):
npm run dev

# Full app with the Rust core and hot-reloading UI:
npm run app:dev

# Typecheck / lint / release build:
npm run typecheck
npm run lint
npm run app:build        # NSIS installer in src-tauri/target/release/bundle/
```

Prerequisites: Node 20+, Rust stable (MSVC), WebView2 runtime (preinstalled on Windows 10/11), VS Build Tools with C++ workload.

## Branding

The amber bolt (`assets/orin-mark.svg`, rendered by `scripts/generate-icons.mjs` into `src-tauri/icons/`) is the single product mark used across the window, installer, and UI.

`_legacy_prototype/` holds the original Electron proof-of-concept, kept for reference only.
