#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod dedupe;
mod history;
#[cfg(target_os = "macos")]
mod macos;

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use history::HistoryStore;

pub struct AppState {
    pub history: Arc<Mutex<HistoryStore>>,
}

#[cfg(target_os = "macos")]
fn install_macos_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Differ"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();

    let check_update = MenuItemBuilder::with_id("check_update", "Check for Updates…").build(app)?;

    let app_submenu = SubmenuBuilder::new(app, "Differ")
        .about(Some(about_metadata))
        .separator()
        .item(&check_update)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_submenu, &edit_submenu, &window_submenu])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "check_update" {
                let _ = app.emit("update-check-requested", ());
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            macos::disable_webview_scroll_elasticity(app);

            #[cfg(target_os = "macos")]
            install_macos_menu(app.handle())?;

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
            commands::open_external_url,
            commands::history_load,
            commands::history_capture,
            commands::history_delete,
            commands::history_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
