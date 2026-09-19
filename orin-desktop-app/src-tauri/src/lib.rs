// Orin Code — Tauri application entry. Command surface lives in `bridge/`;
// see ../../docs/BRIDGE.md for the renderer contract these implement.
mod bridge;

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // A second launch should focus the existing window; handled in bridge::init.
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(bridge::AppState::default())
        .setup(|app| {
            bridge::init(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::store::store_get,
            bridge::store::store_set,
            bridge::store::store_delete,
            bridge::ai::ai_send,
            bridge::ai::ai_abort,
            bridge::ai::models_list,
            bridge::ai::models_fetch,
            bridge::ai::providers_list,
            bridge::ai::provider_set_key,
            bridge::ai::provider_has_key,
            bridge::auth::auth_login,
            bridge::auth::auth_register,
            bridge::auth::auth_device_start,
            bridge::auth::auth_device_wait,
            bridge::auth::open_external,
            bridge::auth::auth_status,
            bridge::auth::auth_logout,
            bridge::sync::sync_pull,
            bridge::sync::sync_push,
            bridge::telegram::telegram_set_token,
            bridge::telegram::telegram_has_token,
            bridge::telegram::telegram_notify,
            bridge::fs::dialog_pick_folder,
            bridge::fs::fs_read_dir,
            bridge::fs::fs_read_file,
            bridge::fs::fs_write_file,
            bridge::fs::fs_exists,
            bridge::fs::git_status,
            bridge::fs::search_workspace,
            bridge::term::term_create,
            bridge::term::term_write,
            bridge::term::term_resize,
            bridge::term::term_kill,
            bridge::agent::agent_run,
            bridge::agent::agent_stop,
            bridge::agent::approval_respond,
            bridge::cu::cu_start,
            bridge::cu::cu_stop,
            bridge::cu::cu_permission_respond,
            bridge::cu::cu_available_providers,
            bridge::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Orin Code");
}
