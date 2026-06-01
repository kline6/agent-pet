// AI Chat module - Xiaomi MIMO API integration
// OpenAI-compatible chat completions endpoint

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f64,
    max_tokens: u32,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Deserialize)]
struct ChatResponseMessage {
    content: String,
}

pub async fn chat_completion(
    api_key: &str,
    base_url: &str,
    model: &str,
    system_prompt: &str,
    messages: &[ChatMessage],
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut full_messages = Vec::new();

    // Add system prompt if provided
    if !system_prompt.is_empty() {
        full_messages.push(ChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
        });
    }

    full_messages.extend_from_slice(messages);

    let request = ChatRequest {
        model: model.to_string(),
        messages: full_messages,
        temperature: 0.8,
        max_tokens: 1024,
    };

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!("API error ({}): {}", status, body));
    }

    let chat_response: ChatResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {} - Body: {}", e, body))?;

    chat_response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| "No response from API".to_string())
}
