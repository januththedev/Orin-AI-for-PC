// Bridge: the command surface between the Rust core and the React UI.
// Contract: docs/BRIDGE.md — command/event names must match exactly.
pub mod agent;
pub mod ai;
pub mod ai_impl;
pub mod auth;
pub mod connectors;
pub mod cu;
pub mod fs;
pub mod models_fetch;
pub mod presets;
pub mod store;
pub mod sync;
pub mod telegram;
pub mod term;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct AppState {
    /// Cached path of the SQLite workspace database (opened per command).
    pub db_path: Mutex<Option<std::path::PathBuf>>,
    pub flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Shared with spawned agent/cu run loops so they can poll for decisions.
    /// Arc'd because the command handlers only borrow `AppState`.
    pub approvals: Arc<Mutex<HashMap<String, bool>>>,
    pub terminals: Mutex<HashMap<String, term::TermHandle>>,
    /// Cached short-lived Firebase ID token for Orin Cloud calls.
    pub auth_cache: std::sync::Mutex<auth::TokenCache>,
}

impl AppState {
    pub fn register_flag(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.flags.lock() {
            guard.insert(id.to_string(), flag.clone());
        }
        flag
    }

    pub fn trip_flag(&self, id: &str) {
        if let Ok(guard) = self.flags.lock() {
            if let Some(flag) = guard.get(id) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }

    pub fn take_flag(&self, id: &str) -> Option<Arc<AtomicBool>> {
        self.flags.lock().ok().and_then(|mut guard| guard.remove(id))
    }
}

pub fn init(app: tauri::AppHandle) {
    log::info!("Orin AI core initialized (v{})", env!("CARGO_PKG_VERSION"));
    let _ = app; // single-instance focus handling can hook here
}

#[tauri::command]
pub fn app_info() -> serde_json::Value {
    serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS })
}
