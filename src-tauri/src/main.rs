#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dedupe;
mod history;
#[cfg(target_os = "macos")]
mod macos;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

use history::HistoryStore;

pub struct AppState {
    pub history: Arc<Mutex<HistoryStore>>,
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            macos::disable_webview_scroll_elasticity(app);

            let handle = app.handle().clone();
            let store = runtime.block_on(async {
                HistoryStore::load_from_app_dir(&handle)
                    .await
                    .unwrap_or_else(|err| {
                        eprintln!("history load failed: {err:?}");
                        HistoryStore::new_in_memory()
                    })
            });
            app.manage(AppState {
                history: Arc::new(Mutex::new(store)),
            });
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::history_load,
            commands::history_capture,
            commands::history_delete,
            commands::history_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
