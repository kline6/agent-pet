use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

const APP_CONFIG_DIR: &str = "agent-pet";
const LEGACY_CONFIG_DIR: &str = "codex-pet";

const DEFAULT_MIMO_BASE_URL: &str = "https://token-plan-cn.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL: &str = "mimo-v2.5-pro";
const DEFAULT_PET_SYSTEM_PROMPT: &str = "你是主人的专属宠物助手。你忠诚、可爱、活泼，时刻为主人服务。\n你的职责是帮助主人处理各种任务，回答问题，提供陪伴。\n你说话风格亲切可爱，偶尔会用一些俏皮的语气词。\n你称用户为\"主人\"，自称\"小宠\"。\n你关心主人的工作和生活，会主动提醒主人注意休息。";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub live_source_paths: HashMap<String, String>,
    #[serde(default)]
    pub live_source_focus_targets: HashMap<String, String>,
    #[serde(default)]
    pub live_source_enabled: HashMap<String, bool>,
    #[serde(default)]
    pub live_source_prefix_enabled: bool,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub pet_position: Option<PetPosition>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub mimo_api_key: String,
    #[serde(default = "default_mimo_base_url")]
    pub mimo_base_url: String,
    #[serde(default = "default_mimo_model")]
    pub mimo_model: String,
    #[serde(default = "default_pet_system_prompt")]
    pub pet_system_prompt: String,
    #[serde(default)]
    pub selected_pet: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            live_source_paths: HashMap::new(),
            live_source_focus_targets: HashMap::new(),
            live_source_enabled: HashMap::new(),
            live_source_prefix_enabled: false,
            language: default_language(),
            pet_position: None,
            auto_start: false,
            always_on_top: true,
            mimo_api_key: String::new(),
            mimo_base_url: default_mimo_base_url(),
            mimo_model: default_mimo_model(),
            pet_system_prompt: default_pet_system_prompt(),
            selected_pet: None,
        }
    }
}

fn default_language() -> String {
    "en".to_string()
}

fn default_mimo_base_url() -> String {
    DEFAULT_MIMO_BASE_URL.to_string()
}

fn default_mimo_model() -> String {
    DEFAULT_MIMO_MODEL.to_string()
}

fn default_pet_system_prompt() -> String {
    DEFAULT_PET_SYSTEM_PROMPT.to_string()
}

pub fn load_settings() -> AppSettings {
    let Some(path) = readable_settings_path() else {
        return AppSettings::default();
    };

    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| "Config dir not found".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent".to_string())?;

    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

fn settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|config| config.join(APP_CONFIG_DIR).join("settings.json"))
}

fn readable_settings_path() -> Option<PathBuf> {
    let config = dirs::config_dir()?;
    let current = config.join(APP_CONFIG_DIR).join("settings.json");
    if current.exists() {
        return Some(current);
    }

    let legacy = config.join(LEGACY_CONFIG_DIR).join("settings.json");
    if legacy.exists() {
        return Some(legacy);
    }

    Some(current)
}
