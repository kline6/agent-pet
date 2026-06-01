use rusqlite::{Connection, params};
use std::sync::Mutex;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub struct ChatDatabase {
    conn: Mutex<Connection>,
}

impl ChatDatabase {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let db_path = app_data_dir.join("chat_history.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        // Create conversations table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        ).map_err(|e| e.to_string())?;

        // Create messages table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            )",
            [],
        ).map_err(|e| e.to_string())?;

        Ok(ChatDatabase {
            conn: Mutex::new(conn),
        })
    }

    pub fn create_conversation(&self, title: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO conversations (title) VALUES (?1)",
            params![title],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn save_message(&self, conversation_id: i64, role: &str, content: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES (?1, ?2, ?3)",
            params![conversation_id, role, content],
        ).map_err(|e| e.to_string())?;

        // Update conversation updated_at
        conn.execute(
            "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![conversation_id],
        ).map_err(|e| e.to_string())?;

        Ok(conn.last_insert_rowid())
    }

    pub fn get_conversations(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let conversations = stmt
            .query_map([], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(conversations)
    }

    pub fn get_messages(&self, conversation_id: i64) -> Result<Vec<Message>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, conversation_id, role, content, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;

        let messages = stmt
            .query_map(params![conversation_id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(messages)
    }

    pub fn delete_conversation(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Delete messages first (foreign key cascade should handle this, but be explicit)
        conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn search_conversations(&self, keyword: &str) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE title LIKE ?1 ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;

        let search_pattern = format!("%{}%", keyword);
        let conversations = stmt
            .query_map(params![search_pattern], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(conversations)
    }
}