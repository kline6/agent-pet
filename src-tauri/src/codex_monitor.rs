// Watches Codex session JSONL files and maps live Codex activity to pet messages.

use crate::message::{
    MSG_ERROR, MSG_MENTION, MSG_NEW_MESSAGE, MSG_PROCESSING, MSG_SUCCESS, MSG_WAITING_INPUT,
};
use crate::state_machine::PetStateMachine;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::async_runtime::Mutex;

struct CodexActivity {
    message_type: &'static str,
    bubble_text: Option<String>,
    origin: ActivityOrigin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivityOrigin {
    User,
    Assistant,
}

pub struct CodexMonitor {
    state_machine: Arc<Mutex<PetStateMachine>>,
}

impl CodexMonitor {
    pub fn new(state_machine: Arc<Mutex<PetStateMachine>>) -> Self {
        Self { state_machine }
    }

    pub async fn run(&self) {
        let mut codex_cursor = FileCursor::default();
        let mut claude_cursor = FileCursor::default();

        loop {
            let (codex_path, claude_path) = {
                let sm = self.state_machine.lock().await;
                (
                    expand_source_path(sm.live_source_path("codex")),
                    expand_source_path(sm.live_source_path("claude")),
                )
            };

            if let Some(sessions_dir) = codex_path.as_deref() {
                if let Err(e) = poll_jsonl_source(
                    sessions_dir,
                    &mut codex_cursor,
                    &self.state_machine,
                    "codex",
                    is_codex_session_file,
                    codex_line_to_activity,
                )
                .await
                {
                    log::warn!("Codex monitor poll failed: {}", e);
                }
            }

            if let Some(projects_dir) = claude_path.as_deref() {
                if let Err(e) = poll_jsonl_source(
                    projects_dir,
                    &mut claude_cursor,
                    &self.state_machine,
                    "claude",
                    is_jsonl_file,
                    claude_line_to_activity,
                )
                .await
                {
                    log::warn!("Claude monitor poll failed: {}", e);
                }
            }

            tokio::time::sleep(Duration::from_millis(700)).await;
        }
    }
}

#[derive(Default)]
struct FileCursor {
    path: Option<PathBuf>,
    offset: u64,
}

async fn poll_jsonl_source(
    root: &Path,
    cursor: &mut FileCursor,
    state_machine: &Arc<Mutex<PetStateMachine>>,
    source: &'static str,
    file_filter: fn(&Path) -> bool,
    parser: fn(&str) -> Option<CodexActivity>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = newest_jsonl_file(root, file_filter)? else {
        return Ok(());
    };

    if cursor.path.as_ref() != Some(&path) {
        let len = fs::metadata(&path)?.len();
        cursor.path = Some(path);
        cursor.offset = len;
        if let Some(activity) = latest_activity_in_file(cursor.path.as_ref().unwrap(), parser)? {
            emit_activity(state_machine, source, activity).await;
        }
        return Ok(());
    }

    let len = fs::metadata(&path)?.len();
    if len < cursor.offset {
        cursor.offset = len;
        return Ok(());
    }
    if len == cursor.offset {
        return Ok(());
    }

    let mut file = File::open(&path)?;
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut appended = String::new();
    file.read_to_string(&mut appended)?;
    cursor.offset = len;

    for line in appended.lines() {
        if let Some(activity) = parser(line) {
            emit_activity(state_machine, source, activity).await;
        }
    }

    Ok(())
}

async fn emit_activity(
    state_machine: &Arc<Mutex<PetStateMachine>>,
    source: &str,
    activity: CodexActivity,
) {
    if activity.origin == ActivityOrigin::User {
        return;
    }

    let mut sm = state_machine.lock().await;
    if sm.live_source_enabled(source) {
        let prefix_enabled = sm.live_source_prefix_enabled();
        sm.handle_message(activity.message_type);
        if let Some(text) = activity.bubble_text {
            let bubble_text = if prefix_enabled {
                format_source_bubble_text(source, &text)
            } else {
                text
            };
            sm.show_codex_bubble(&bubble_text, source);
        }
    }
}

fn expand_source_path(path: Option<String>) -> Option<PathBuf> {
    let path = path?;
    let expanded = expand_env_vars(path.trim());
    let trimmed = expanded.trim();

    if trimmed.is_empty() {
        return None;
    }

    if trimmed == "~" {
        dirs::home_dir()
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        dirs::home_dir().map(|home| home.join(rest))
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn expand_env_vars(path: &str) -> String {
    let mut output = String::with_capacity(path.len());
    let mut chars = path.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '%' {
            let mut name = String::new();
            while let Some(&next) = chars.peek() {
                chars.next();
                if next == '%' {
                    break;
                }
                name.push(next);
            }

            if name.is_empty() {
                output.push(ch);
            } else if let Ok(value) = std::env::var(&name) {
                output.push_str(&value);
            } else {
                output.push('%');
                output.push_str(&name);
                output.push('%');
            }
            continue;
        }

        output.push(ch);
    }

    output
}

fn newest_jsonl_file(
    root: &Path,
    file_filter: fn(&Path) -> bool,
) -> Result<Option<PathBuf>, std::io::Error> {
    if root.is_file() {
        return Ok(if file_filter(root) {
            Some(root.to_path_buf())
        } else {
            None
        });
    }

    let mut newest: Option<(PathBuf, SystemTime)> = None;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;

            if file_type.is_dir() {
                stack.push(path);
                continue;
            }

            if !file_filter(&path) {
                continue;
            }

            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            if newest
                .as_ref()
                .map(|(_, current)| modified > *current)
                .unwrap_or(true)
            {
                newest = Some((path, modified));
            }
        }
    }

    Ok(newest.map(|(path, _)| path))
}

fn is_codex_session_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("rollout-"))
            .unwrap_or(false)
}

fn is_jsonl_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
}

#[cfg(test)]
fn codex_line_to_message_type(line: &str) -> Option<&'static str> {
    codex_line_to_activity(line).map(|activity| activity.message_type)
}

fn codex_line_to_activity(line: &str) -> Option<CodexActivity> {
    let value: Value = serde_json::from_str(line).ok()?;
    let record_type = value.get("type")?.as_str()?;
    let payload = value.get("payload");

    match record_type {
        "event_msg" => event_payload_to_activity(payload?),
        "response_item" => response_payload_to_activity(payload?),
        _ => None,
    }
}

fn latest_activity_in_file(
    path: &Path,
    parser: fn(&str) -> Option<CodexActivity>,
) -> Result<Option<CodexActivity>, std::io::Error> {
    const TAIL_BYTES: u64 = 64 * 1024;

    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;

    let mut tail = String::new();
    file.read_to_string(&mut tail)?;
    let lines = if start > 0 {
        tail.lines().skip(1).collect::<Vec<_>>()
    } else {
        tail.lines().collect::<Vec<_>>()
    };

    Ok(lines.into_iter().rev().find_map(parser))
}

fn event_payload_to_activity(payload: &Value) -> Option<CodexActivity> {
    let event_type = payload.get("type")?.as_str()?;

    if event_type.contains("approval")
        || event_type.contains("permission")
        || event_type.contains("input")
    {
        return Some(activity(MSG_WAITING_INPUT, "Needs your input"));
    }

    match event_type {
        "user_message" => Some(CodexActivity {
            message_type: MSG_MENTION,
            bubble_text: payload_message_text(payload).or_else(|| Some("New request".to_string())),
            origin: ActivityOrigin::User,
        }),
        "task_started" => Some(activity(MSG_PROCESSING, "Working...")),
        "agent_message" => Some(CodexActivity {
            message_type: MSG_NEW_MESSAGE,
            bubble_text: payload_message_text(payload)
                .or_else(|| payload_last_agent_message(payload))
                .or_else(|| Some("Codex replied".to_string())),
            origin: ActivityOrigin::Assistant,
        }),
        "task_complete" => Some(CodexActivity {
            message_type: MSG_SUCCESS,
            bubble_text: payload_last_agent_message(payload).or_else(|| Some("Done".to_string())),
            origin: ActivityOrigin::Assistant,
        }),
        "exec_command_end" | "patch_apply_end" => {
            match payload.get("status").and_then(Value::as_str) {
                Some("failed") | Some("error") => Some(activity(MSG_ERROR, "Something failed")),
                _ => Some(activity(MSG_PROCESSING, "Updated")),
            }
        }
        _ => None,
    }
}

fn response_payload_to_activity(payload: &Value) -> Option<CodexActivity> {
    match payload.get("type")?.as_str()? {
        "reasoning"
        | "function_call"
        | "function_call_output"
        | "custom_tool_call"
        | "custom_tool_call_output" => Some(activity(MSG_PROCESSING, "Working...")),
        "message" => match payload.get("role").and_then(Value::as_str) {
            Some("assistant") => Some(CodexActivity {
                message_type: MSG_NEW_MESSAGE,
                bubble_text: response_message_text(payload)
                    .or_else(|| payload_last_agent_message(payload))
                    .or_else(|| Some("Codex replied".to_string())),
                origin: ActivityOrigin::Assistant,
            }),
            Some("user") => Some(CodexActivity {
                message_type: MSG_MENTION,
                bubble_text: response_message_text(payload)
                    .or_else(|| Some("New request".to_string())),
                origin: ActivityOrigin::User,
            }),
            _ => None,
        },
        _ => None,
    }
}

fn claude_line_to_activity(line: &str) -> Option<CodexActivity> {
    let value: Value = serde_json::from_str(line).ok()?;
    let event_type = value.get("type")?.as_str()?;

    match event_type {
        "user" => Some(CodexActivity {
            message_type: MSG_MENTION,
            bubble_text: claude_message_text(&value).or_else(|| Some("New request".to_string())),
            origin: ActivityOrigin::User,
        }),
        "assistant" => {
            if value.get("error").is_some()
                || value.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true)
            {
                return Some(CodexActivity {
                    message_type: MSG_ERROR,
                    bubble_text: claude_message_text(&value)
                        .or_else(|| Some("Something failed".to_string())),
                    origin: ActivityOrigin::Assistant,
                });
            }

            let message = value.get("message")?;
            if message_has_tool_use(message) {
                Some(activity(MSG_PROCESSING, "Working..."))
            } else {
                Some(CodexActivity {
                    message_type: MSG_NEW_MESSAGE,
                    bubble_text: claude_message_text(&value)
                        .or_else(|| Some("Replied".to_string())),
                    origin: ActivityOrigin::Assistant,
                })
            }
        }
        "progress" => Some(activity(MSG_PROCESSING, "Working...")),
        "system" => match value.get("subtype").and_then(Value::as_str) {
            Some("turn_duration") | Some("stop_hook_summary") => {
                Some(activity(MSG_SUCCESS, "Done"))
            }
            _ => None,
        },
        _ => None,
    }
}

fn activity(message_type: &'static str, bubble_text: &str) -> CodexActivity {
    CodexActivity {
        message_type,
        bubble_text: Some(bubble_text.to_string()),
        origin: ActivityOrigin::Assistant,
    }
}

fn claude_message_text(value: &Value) -> Option<String> {
    let content = value.get("message")?.get("content")?;
    content_value_to_text(content).map(|text| truncate_bubble_text(text.trim()))
}

fn content_value_to_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join(" ");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn message_has_tool_use(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
        })
        .unwrap_or(false)
}

fn format_source_bubble_text(source: &str, text: &str) -> String {
    truncate_bubble_text(&format!("{}: {}", source_label(source), text.trim()))
}

fn source_label(source: &str) -> &str {
    match source {
        "codex" => "Codex",
        "claude" => "Claude Code",
        _ => source,
    }
}

fn payload_message_text(payload: &Value) -> Option<String> {
    payload
        .get("message")
        .and_then(message_value_to_text)
        .map(|text| truncate_bubble_text(text.trim()))
}

fn payload_last_agent_message(payload: &Value) -> Option<String> {
    payload
        .get("last_agent_message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(truncate_bubble_text)
}

fn response_message_text(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    message_value_to_text(content).map(|text| truncate_bubble_text(text.trim()))
}

fn message_value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join(" ");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| map.get("content").and_then(message_value_to_text)),
        _ => None,
    }
}

fn truncate_bubble_text(text: &str) -> String {
    const MAX_CHARS: usize = 92;
    let mut chars = text.chars();
    let shortened: String = chars.by_ref().take(MAX_CHARS).collect();

    if chars.next().is_some() {
        format!("{}...", shortened.trim_end())
    } else {
        shortened
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_codex_task_started_to_processing() {
        let line = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        assert_eq!(codex_line_to_message_type(line), Some(MSG_PROCESSING));
    }

    #[test]
    fn maps_codex_failed_command_to_error() {
        let line =
            r#"{"type":"event_msg","payload":{"type":"exec_command_end","status":"failed"}}"#;
        assert_eq!(codex_line_to_message_type(line), Some(MSG_ERROR));
    }

    #[test]
    fn maps_codex_task_complete_to_success() {
        let line = r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#;
        assert_eq!(codex_line_to_message_type(line), Some(MSG_SUCCESS));
    }

    #[test]
    fn extracts_assistant_message_text_for_bubble() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello from Codex"}]}}"#;
        let activity = codex_line_to_activity(line).unwrap();
        assert_eq!(activity.message_type, MSG_NEW_MESSAGE);
        assert_eq!(activity.bubble_text.as_deref(), Some("Hello from Codex"));
        assert_eq!(activity.origin, ActivityOrigin::Assistant);
    }

    #[test]
    fn extracts_user_message_text_for_bubble() {
        let line = r#"{"type":"event_msg","payload":{"type":"user_message","message":"Use the current message"}}"#;
        let activity = codex_line_to_activity(line).unwrap();
        assert_eq!(activity.message_type, MSG_MENTION);
        assert_eq!(
            activity.bubble_text.as_deref(),
            Some("Use the current message")
        );
        assert_eq!(activity.origin, ActivityOrigin::User);
    }

    #[test]
    fn ignores_unrelated_codex_events() {
        let line = r#"{"type":"event_msg","payload":{"type":"token_count"}}"#;
        assert_eq!(codex_line_to_message_type(line), None);
    }
}
