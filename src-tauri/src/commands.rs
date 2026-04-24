use tauri::State;

use crate::history::HistoryFile;
use crate::AppState;

fn map_err<E: std::fmt::Debug>(e: E) -> String {
    format!("{e:?}")
}

#[tauri::command]
pub async fn history_load(state: State<'_, AppState>) -> Result<HistoryFile, String> {
    let store = state.history.lock().await;
    Ok(store.file.clone())
}

#[tauri::command]
pub async fn history_capture(
    state: State<'_, AppState>,
    original: String,
    modified: String,
    language: String,
    force: Option<bool>,
) -> Result<HistoryFile, String> {
    let mut store = state.history.lock().await;
    store
        .capture(original, modified, language, force.unwrap_or(false))
        .await
        .map_err(map_err)?;
    Ok(store.file.clone())
}

#[tauri::command]
pub async fn history_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<HistoryFile, String> {
    let mut store = state.history.lock().await;
    store.delete(&id).await.map_err(map_err)?;
    Ok(store.file.clone())
}

#[tauri::command]
pub async fn history_clear(state: State<'_, AppState>) -> Result<HistoryFile, String> {
    let mut store = state.history.lock().await;
    store.clear().await.map_err(map_err)?;
    Ok(store.file.clone())
}
