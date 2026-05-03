use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection};

use crate::git::{GitHistoryEntry, GitHistoryStatus, GitStatus, GitStatusEntry};

pub struct HistoryStore {
    root: PathBuf,
    conn: Mutex<Connection>,
}

impl HistoryStore {
    pub fn open(root: &Path, db_path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS history_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                status TEXT NOT NULL,
                subject TEXT NOT NULL,
                author TEXT NOT NULL,
                changed_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_history_events_changed_at
                ON history_events(changed_at DESC, id DESC);",
        )?;
        Ok(Self {
            root: root.to_path_buf(),
            conn: Mutex::new(conn),
        })
    }

    pub fn record_changes(&self, abs_paths: &[String]) {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let conn = self.conn.lock().unwrap();
        let mut seen = std::collections::HashSet::<String>::new();
        for abs in abs_paths {
            let abs_path = std::path::Path::new(abs);
            let rel_pb = match abs_path.strip_prefix(&self.root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            let rel = rel_pb.to_string_lossy().replace('\\', "/");
            if rel.is_empty() || rel.starts_with("..") {
                continue;
            }
            if !seen.insert(rel.clone()) {
                continue;
            }
            let exists = abs_path.exists();
            let status = if exists { "modified" } else { "deleted" };
            let subject = if exists { "Edited file" } else { "Deleted file" };
            let _ = conn.execute(
                "INSERT INTO history_events (path, status, subject, author, changed_at) VALUES (?, ?, ?, ?, ?)",
                params![rel, status, subject, "treepeek", &now],
            );
        }
        let _ = conn.execute(
            "DELETE FROM history_events WHERE id NOT IN (SELECT id FROM history_events ORDER BY changed_at DESC, id DESC LIMIT 1000)",
            [],
        );
    }

    pub fn list(&self, git_status: Option<&[GitStatusEntry]>) -> Vec<GitHistoryEntry> {
        let mut out: Vec<GitHistoryEntry> = Vec::new();
        if let Some(gs) = git_status {
            for entry in gs {
                if matches!(entry.status, GitStatus::Ignored) {
                    continue;
                }
                out.push(GitHistoryEntry {
                    path: entry.path.clone(),
                    status: status_to_history(entry.status),
                    commit_hash: None,
                    commit_short_hash: None,
                    subject: "Uncommitted change".into(),
                    author: "Working tree".into(),
                    date: None,
                    relative_date: Some("now".into()),
                    pending: true,
                });
            }
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT path, status, subject, author, changed_at FROM history_events ORDER BY changed_at DESC, id DESC LIMIT 300",
        ) {
            Ok(s) => s,
            Err(_) => return out,
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        });
        if let Ok(rows) = rows {
            for r in rows.flatten() {
                let (path, status, subject, author, changed_at) = r;
                out.push(GitHistoryEntry {
                    path,
                    status: parse_history_status(&status),
                    commit_hash: None,
                    commit_short_hash: None,
                    subject,
                    author,
                    date: Some(changed_at.clone()),
                    relative_date: Some(format_relative(&changed_at)),
                    pending: false,
                });
            }
        }
        out
    }
}

fn status_to_history(s: GitStatus) -> GitHistoryStatus {
    match s {
        GitStatus::Added => GitHistoryStatus::Added,
        GitStatus::Deleted => GitHistoryStatus::Deleted,
        GitStatus::Ignored => GitHistoryStatus::Ignored,
        GitStatus::Modified => GitHistoryStatus::Modified,
        GitStatus::Renamed => GitHistoryStatus::Renamed,
        GitStatus::Untracked => GitHistoryStatus::Untracked,
    }
}

fn parse_history_status(s: &str) -> GitHistoryStatus {
    match s {
        "added" => GitHistoryStatus::Added,
        "deleted" => GitHistoryStatus::Deleted,
        "ignored" => GitHistoryStatus::Ignored,
        "modified" => GitHistoryStatus::Modified,
        "renamed" => GitHistoryStatus::Renamed,
        "untracked" => GitHistoryStatus::Untracked,
        "copied" => GitHistoryStatus::Copied,
        "typechange" => GitHistoryStatus::Typechange,
        _ => GitHistoryStatus::Unknown,
    }
}

fn format_relative(iso: &str) -> String {
    let parsed = DateTime::parse_from_rfc3339(iso);
    let Ok(dt) = parsed else {
        return String::new();
    };
    let seconds = (Utc::now() - dt.with_timezone(&Utc)).num_seconds().max(0);
    if seconds < 60 {
        return "just now".into();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{}m ago", minutes);
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{}h ago", hours);
    }
    let days = hours / 24;
    if days < 30 {
        return format!("{}d ago", days);
    }
    let months = days / 30;
    if months < 12 {
        return format!("{}mo ago", months);
    }
    format!("{}y ago", months / 12)
}
