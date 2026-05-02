use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InstanceInfo {
    pub port: u16,
    pub host: String,
    pub root: String,
    #[serde(rename = "displayRoot")]
    pub display_root: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
}

fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("treepeek")
        .join("instances")
}

pub fn register_instance(info: &InstanceInfo) {
    let d = dir();
    let _ = fs::create_dir_all(&d);
    let _ = fs::set_permissions(&d, fs::Permissions::from_mode(0o700));
    let path = d.join(format!("{}.json", info.port));
    if let Ok(json) = serde_json::to_string(info) {
        let _ = fs::write(&path, json);
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
}

pub fn unregister_instance(port: u16) {
    let path = dir().join(format!("{}.json", port));
    let _ = fs::remove_file(path);
}

fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

pub fn list_instances() -> Vec<InstanceInfo> {
    let entries = match fs::read_dir(dir()) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => {
                let _ = fs::remove_file(&path);
                continue;
            }
        };
        let info: InstanceInfo = match serde_json::from_str(&raw) {
            Ok(i) => i,
            Err(_) => {
                let _ = fs::remove_file(&path);
                continue;
            }
        };
        if !is_pid_alive(info.pid) {
            let _ = fs::remove_file(&path);
            continue;
        }
        out.push(info);
    }
    out.sort_by_key(|i| i.started_at);
    out
}
