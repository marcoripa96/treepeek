use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use base64::Engine;
use rand::RngCore;
use subtle::ConstantTimeEq;

pub const COOKIE_NAME: &str = "tp_session";

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".config").join("treepeek")
}

fn token_file() -> PathBuf {
    config_dir().join("token")
}

pub fn load_or_create_token(rotate: bool, override_token: Option<String>) -> std::io::Result<String> {
    if let Some(t) = override_token {
        return Ok(t);
    }
    if !rotate {
        if let Ok(existing) = fs::read_to_string(token_file()) {
            let trimmed = existing.trim();
            if trimmed.len() >= 32 {
                return Ok(trimmed.to_string());
            }
        }
    }
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let fresh = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    fs::create_dir_all(config_dir())?;
    let _ = fs::set_permissions(config_dir(), fs::Permissions::from_mode(0o700));
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(token_file())?;
    file.write_all(fresh.as_bytes())?;
    Ok(fresh)
}

pub fn read_cookie(header: Option<&str>, name: &str) -> Option<String> {
    let raw = header?;
    for part in raw.split(';') {
        let part = part.trim();
        let mut it = part.splitn(2, '=');
        let k = it.next()?;
        if k == name {
            return Some(it.next().unwrap_or("").to_string());
        }
    }
    None
}

pub fn token_matches(provided: Option<&str>, expected: &str) -> bool {
    let Some(p) = provided else {
        return false;
    };
    let a = p.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

pub fn is_authenticated(query_k: Option<&str>, cookie_header: Option<&str>, token: &str) -> bool {
    if let Some(q) = query_k {
        if token_matches(Some(q), token) {
            return true;
        }
    }
    let cookie = read_cookie(cookie_header, COOKIE_NAME);
    token_matches(cookie.as_deref(), token)
}
