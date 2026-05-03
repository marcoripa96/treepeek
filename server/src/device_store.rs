use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use webauthn_rs::prelude::Passkey;

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceRow {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub last_seen_at: String,
}

pub struct StoredPasskey {
    pub device_id: i64,
    pub passkey: Passkey,
}

pub struct DeviceStore {
    conn: Mutex<Connection>,
}

impl DeviceStore {
    pub fn open(db_path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_uuid BLOB NOT NULL,
                credential_id BLOB NOT NULL UNIQUE,
                name TEXT NOT NULL,
                passkey TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                device_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_devices(&self) -> Vec<DeviceRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, name, created_at, last_seen_at FROM devices ORDER BY last_seen_at DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], |row| {
            Ok(DeviceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                last_seen_at: row.get(3)?,
            })
        });
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    pub fn add_device(
        &self,
        user_uuid: &[u8],
        credential_id: &[u8],
        name: &str,
        passkey: &Passkey,
    ) -> rusqlite::Result<i64> {
        let json = serde_json::to_string(passkey)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let now = now_iso();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO devices (user_uuid, credential_id, name, passkey, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![user_uuid, credential_id, name, json, now, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn delete_device(&self, id: i64) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM devices WHERE id = ?", params![id])
    }

    pub fn passkey_for_credential(&self, credential_id: &[u8]) -> Option<StoredPasskey> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, passkey FROM devices WHERE credential_id = ? LIMIT 1")
            .ok()?;
        let row: Option<(i64, String)> = stmt
            .query_row(params![credential_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()
            .ok()
            .flatten();
        let (id, json) = row?;
        let passkey: Passkey = serde_json::from_str(&json).ok()?;
        Some(StoredPasskey {
            device_id: id,
            passkey,
        })
    }

    pub fn all_passkeys(&self) -> Vec<Passkey> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT passkey FROM devices") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| row.get::<_, String>(0));
        let Ok(rows) = rows else {
            return Vec::new();
        };
        rows.flatten()
            .filter_map(|s| serde_json::from_str::<Passkey>(&s).ok())
            .collect()
    }

    pub fn all_credential_ids(&self) -> Vec<Vec<u8>> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT credential_id FROM devices") else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| row.get::<_, Vec<u8>>(0));
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    pub fn update_passkey(&self, device_id: i64, passkey: &Passkey) -> rusqlite::Result<()> {
        let json = serde_json::to_string(passkey)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE devices SET passkey = ?, last_seen_at = ? WHERE id = ?",
            params![json, now_iso(), device_id],
        )?;
        Ok(())
    }

    pub fn touch_device(&self, device_id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE devices SET last_seen_at = ? WHERE id = ?",
            params![now_iso(), device_id],
        );
    }

    pub fn create_session(&self, device_id: i64, ttl: Duration) -> rusqlite::Result<String> {
        let sid = random_token();
        let expires = (Utc::now() + chrono::Duration::from_std(ttl).unwrap_or(chrono::Duration::seconds(0)))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, device_id, expires_at) VALUES (?, ?, ?)",
            params![sid, device_id, expires],
        )?;
        Ok(sid)
    }

    pub fn validate_session(&self, sid: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT device_id, expires_at FROM sessions WHERE id = ? LIMIT 1")
            .ok()?;
        let row: Option<(i64, String)> = stmt
            .query_row(params![sid], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .ok()
            .flatten();
        let (device_id, expires) = row?;
        let exp = DateTime::parse_from_rfc3339(&expires).ok()?;
        if exp.with_timezone(&Utc) < Utc::now() {
            return None;
        }
        Some(device_id)
    }

    pub fn renew_session(&self, sid: &str, ttl: Duration) {
        let new_expires = (Utc::now()
            + chrono::Duration::from_std(ttl).unwrap_or(chrono::Duration::seconds(0)))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE sessions SET expires_at = ? WHERE id = ?",
            params![new_expires, sid],
        );
    }

    pub fn revoke_session(&self, sid: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM sessions WHERE id = ?", params![sid]);
    }

    pub fn cleanup_expired(&self) {
        let now = now_iso();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM sessions WHERE expires_at < ?", params![now]);
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
