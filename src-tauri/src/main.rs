// Agent Pet Desktop - Main Entry Point
// Compatible with Codex pet protocol: 1536x1872, 8x9 grid, 192x208 cells


#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod codex_monitor;
mod focus;
mod message;
mod pet;
mod settings;
mod state_machine;
mod tray;
mod chat;
mod websocket;
mod database;

use std::sync::Arc;
use tauri::async_runtime::Mutex;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

use crate::codex_monitor::CodexMonitor;
use crate::state_machine::{
    default_live_source_focus_targets, default_live_source_paths, PetStateMachine,
};
use crate::websocket::WebSocketServer;

pub struct AppState {
    pub state_machine: Arc<Mutex<PetStateMachine>>,
    pub chat_db: Arc<database::ChatDatabase>,
}

#[tauri::command]
async fn get_pet_list(app: tauri::AppHandle) -> Result<Vec<pet::PetInfo>, String> {
    pet::list_pets(app).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_user_pet_dir() -> Result<String, String> {
    pet::user_pets_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_pet(
    state: tauri::State<'_, AppState>,
    pet_id: String,
) -> Result<pet::PetConfig, String> {
    let mut sm = state.state_machine.lock().await;
    sm.load_pet(&pet_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_current_state(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.current_state().to_string())
}

#[tauri::command]
async fn trigger_state(
    state: tauri::State<'_, AppState>,
    message_type: String,
) -> Result<String, String> {
    let mut sm = state.state_machine.lock().await;
    let new_state = sm.handle_message(&message_type);
    Ok(new_state.to_string())
}

#[tauri::command]
async fn get_message_map(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let sm = state.state_machine.lock().await;
    Ok(serde_json::to_value(sm.message_map()).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn update_message_map(
    state: tauri::State<'_, AppState>,
    map: serde_json::Value,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    let new_map: std::collections::HashMap<String, String> =
        serde_json::from_value(map).map_err(|e| e.to_string())?;
    sm.set_message_map(new_map);
    Ok(())
}

#[tauri::command]
async fn get_websocket_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sm = state.state_machine.lock().await;
    Ok(serde_json::json!({
        "enabled": sm.websocket_enabled(),
        "port": sm.websocket_port(),
    }))
}

#[tauri::command]
async fn toggle_websocket(state: tauri::State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_websocket_enabled(enabled);
    Ok(())
}

#[tauri::command]
async fn get_codex_monitor_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sm = state.state_machine.lock().await;
    Ok(serde_json::json!({
        "enabled": sm.codex_monitor_enabled(),
    }))
}

#[tauri::command]
async fn toggle_codex_monitor(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_codex_monitor_enabled(enabled);
    Ok(())
}

#[tauri::command]
async fn get_live_sources_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sm = state.state_machine.lock().await;
    let paths = sm.live_source_paths();
    let defaults = default_live_source_paths();
    let focus_targets = sm.live_source_focus_targets();
    let default_focus_targets = default_live_source_focus_targets();

    Ok(serde_json::json!({
        "codex": {
            "enabled": sm.codex_monitor_enabled(),
            "path": paths.get("codex"),
            "defaultPath": defaults.get("codex"),
            "focusTarget": focus_targets.get("codex"),
            "defaultFocusTarget": default_focus_targets.get("codex"),
        },
        "claude": {
            "enabled": sm.claude_monitor_enabled(),
            "path": paths.get("claude"),
            "defaultPath": defaults.get("claude"),
            "focusTarget": focus_targets.get("claude"),
            "defaultFocusTarget": default_focus_targets.get("claude"),
        },
        "prefixEnabled": sm.live_source_prefix_enabled(),
    }))
}

#[tauri::command]
async fn toggle_live_source(
    state: tauri::State<'_, AppState>,
    source: String,
    enabled: bool,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_live_source_enabled(&source, enabled)
}

#[tauri::command]
async fn set_live_source_path(
    state: tauri::State<'_, AppState>,
    source: String,
    path: String,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_live_source_path(&source, path)
}

#[tauri::command]
async fn set_live_source_focus_target(
    state: tauri::State<'_, AppState>,
    source: String,
    target: String,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_live_source_focus_target(&source, target)
}

#[tauri::command]
async fn focus_live_source(
    state: tauri::State<'_, AppState>,
    source: String,
) -> Result<(), String> {
    let target = {
        let sm = state.state_machine.lock().await;
        sm.live_source_focus_target(&source)?
    };

    match focus::focus_target(&target) {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!(
                "Failed to focus live source '{}' with target '{}': {}",
                source,
                target,
                e
            );
            Err(e)
        }
    }
}

#[tauri::command]
async fn set_live_source_prefix_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_live_source_prefix_enabled(enabled)
}

#[tauri::command]
async fn get_live_source_prefix_enabled(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.live_source_prefix_enabled())
}

#[tauri::command]
async fn get_pet_scale(state: tauri::State<'_, AppState>) -> Result<f64, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.pet_scale())
}

#[tauri::command]
async fn set_pet_scale(state: tauri::State<'_, AppState>, scale: f64) -> Result<f64, String> {
    let mut sm = state.state_machine.lock().await;
    Ok(sm.set_pet_scale(scale))
}

#[tauri::command]
async fn get_language(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.language().to_string())
}

#[tauri::command]
async fn set_language(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    let lang = language.clone();
    let mut sm = state.state_machine.lock().await;
    sm.set_language(language)?;
    drop(sm);
    tray::rebuild_tray(&app, &lang).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn respond_permission(
    state: tauri::State<'_, AppState>,
    callback_id: String,
    approved: bool,
) -> Result<(), String> {
    log::info!("Permission response: callback_id={}, approved={}", callback_id, approved);
    // Future: forward response to connected WebSocket clients via callback_id
    let _ = (&state, &callback_id);
    Ok(())
}

#[tauri::command]
async fn save_pet_position(
    state: tauri::State<'_, AppState>,
    x: i32,
    y: i32,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_pet_position(x, y)
}

#[tauri::command]
async fn get_pet_position(
    state: tauri::State<'_, AppState>,
) -> Result<Option<(i32, i32)>, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.pet_position().map(|p| (p.x, p.y)))
}

#[tauri::command]
async fn get_autostart_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    // Check both settings and system-level state
    let sm = state.state_machine.lock().await;
    let settings_enabled = sm.auto_start();
    drop(sm);

    // Also check the actual plugin state
    let autostart = app.state::<tauri_plugin_autostart::AutoLaunchManager>();
    let system_enabled = autostart.is_enabled().unwrap_or(false);

    // Return true if either is enabled (and sync them)
    Ok(settings_enabled || system_enabled)
}

#[tauri::command]
async fn set_autostart(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    // Save to settings
    let mut sm = state.state_machine.lock().await;
    sm.set_auto_start(enabled)?;
    drop(sm);

    // Also toggle the system-level autostart via plugin
    let autostart = app.state::<tauri_plugin_autostart::AutoLaunchManager>();
    if enabled {
        let _ = autostart.enable();
    } else {
        let _ = autostart.disable();
    }

    Ok(())
}

#[tauri::command]
async fn get_always_on_top(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.always_on_top())
}

#[tauri::command]
async fn set_always_on_top(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_always_on_top(enabled)
}

#[tauri::command]
async fn get_mimo_api_key(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.mimo_api_key().to_string())
}

#[tauri::command]
async fn save_mimo_api_key(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_mimo_api_key(key)
}

#[tauri::command]
async fn get_pet_system_prompt(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.pet_system_prompt().to_string())
}

#[tauri::command]
async fn save_pet_system_prompt(
    state: tauri::State<'_, AppState>,
    prompt: String,
) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_pet_system_prompt(prompt)
}

#[tauri::command]
async fn get_chat_config(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let sm = state.state_machine.lock().await;
    Ok(serde_json::json!({
        "baseUrl": sm.mimo_base_url(),
        "model": sm.mimo_model(),
        "hasApiKey": !sm.mimo_api_key().is_empty(),
        "systemPrompt": sm.pet_system_prompt(),
    }))
}

#[tauri::command]
async fn chat_completion(
    state: tauri::State<'_, AppState>,
    messages: Vec<chat::ChatMessage>,
) -> Result<String, String> {
    let sm = state.state_machine.lock().await;
    let api_key = sm.mimo_api_key().to_string();
    let base_url = sm.mimo_base_url().to_string();
    let model = sm.mimo_model().to_string();
    let system_prompt = sm.pet_system_prompt().to_string();
    drop(sm);

    if api_key.is_empty() {
        return Err("API key not configured".to_string());
    }

    chat::chat_completion(&api_key, &base_url, &model, &system_prompt, &messages)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_mimo_connection(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let sm = state.state_machine.lock().await;
    let api_key = sm.mimo_api_key().to_string();
    let base_url = sm.mimo_base_url().to_string();
    let model = sm.mimo_model().to_string();
    drop(sm);

    if api_key.is_empty() {
        return Err("API key not configured".to_string());
    }

    let test_messages = vec![chat::ChatMessage {
        role: "user".to_string(),
        content: "你好".to_string(),
    }];

    chat::chat_completion(&api_key, &base_url, &model, "", &test_messages)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_selected_pet(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let sm = state.state_machine.lock().await;
    Ok(sm.selected_pet())
}

#[tauri::command]
async fn save_selected_pet(state: tauri::State<'_, AppState>, pet_id: String) -> Result<(), String> {
    let mut sm = state.state_machine.lock().await;
    sm.set_selected_pet(Some(pet_id))
}


#[tauri::command]
async fn create_conversation(
    state: tauri::State<'_, AppState>,
    title: String,
) -> Result<i64, String> {
    state.chat_db.create_conversation(&title)
}

#[tauri::command]
async fn save_message(
    state: tauri::State<'_, AppState>,
    conversation_id: i64,
    role: String,
    content: String,
) -> Result<i64, String> {
    state.chat_db.save_message(conversation_id, &role, &content)
}

#[tauri::command]
async fn get_conversations(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<database::Conversation>, String> {
    state.chat_db.get_conversations()
}

#[tauri::command]
async fn get_messages(
    state: tauri::State<'_, AppState>,
    conversation_id: i64,
) -> Result<Vec<database::Message>, String> {
    state.chat_db.get_messages(conversation_id)
}

#[tauri::command]
async fn delete_conversation(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    state.chat_db.delete_conversation(id)
}

#[tauri::command]
async fn search_conversations(
    state: tauri::State<'_, AppState>,
    keyword: String,
) -> Result<Vec<database::Conversation>, String> {
    state.chat_db.search_conversations(&keyword)
}

#[tauri::command]
async fn show_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(window) = app.get_webview_window("chat") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(&app, "chat", WebviewUrl::App("index.html".into()))
        .title("Chat with Pet")
        .inner_size(420.0, 560.0)
        .center()
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Initialize state machine
            let state_machine = Arc::new(Mutex::new(PetStateMachine::new(app_handle.clone())));


            // Initialize chat database
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
            let chat_db = Arc::new(database::ChatDatabase::new(app_data_dir)
                .map_err(|e| format!("Failed to initialize chat database: {}", e))?);

            // Store app state
            app.manage(AppState {
                state_machine: state_machine.clone(),
                chat_db: chat_db.clone(),
            });

            // Setup system tray
            {
                let sm_block = tauri::async_runtime::block_on(state_machine.lock());
                let lang = sm_block.language().to_string();
                drop(sm_block);
                tray::setup_tray(app, &lang)?;
            }

            // Show pet window after setup (allow clicks for interaction)
            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.show();
                let _ = window.set_focus();

                // Restore saved pet position
                {
                    let sm = tauri::async_runtime::block_on(state_machine.lock());
                    if let Some(pos) = sm.pet_position() {
                        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(pos.x, pos.y)));
                    }
                }

                // Save position whenever the pet window moves
                let sm_for_pos = state_machine.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(pos) = event {
                        let mut sm = tauri::async_runtime::block_on(sm_for_pos.lock());
                        let _ = sm.set_pet_position(pos.x, pos.y);
                    }
                });
            }

            let app_handle_clone = app_handle.clone();
            // Spawn WebSocket server
            let sm_clone = state_machine.clone();
            tauri::async_runtime::spawn(async move {
                let server = WebSocketServer::new(8765, sm_clone, app_handle_clone);
                if let Err(e) = server.run().await {
                    log::error!("WebSocket server error: {}", e);
                }
            });

            // Mirror live Codex session activity into pet animations.
            let codex_sm = state_machine.clone();
            tauri::async_runtime::spawn(async move {
                let monitor = CodexMonitor::new(codex_sm);
                monitor.run().await;
            });

            Ok(())
        })
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            get_pet_list,
            get_user_pet_dir,
            load_pet,
            get_current_state,
            trigger_state,
            get_message_map,
            update_message_map,
            get_websocket_status,
            toggle_websocket,
            get_codex_monitor_status,
            toggle_codex_monitor,
            get_live_sources_status,
            toggle_live_source,
            set_live_source_path,
            set_live_source_focus_target,
            focus_live_source,
            set_live_source_prefix_enabled,
            get_live_source_prefix_enabled,
            get_pet_scale,
            set_pet_scale,
            get_language,
            set_language,
            respond_permission,
            save_pet_position,
            get_pet_position,
            get_autostart_status,
            set_autostart,
            get_always_on_top,
            set_always_on_top,
            get_mimo_api_key,
            save_mimo_api_key,
            get_pet_system_prompt,
            save_pet_system_prompt,
            get_chat_config,
            chat_completion,
            test_mimo_connection,
            get_selected_pet,
            save_selected_pet,
            show_chat_window,
            create_conversation,
            save_message,
            get_conversations,
            get_messages,
            delete_conversation,
            search_conversations,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
