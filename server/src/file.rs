use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Serialize;

const TEXT_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const IMAGE_LIMIT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileResult {
    pub path: String,
    pub size: u64,
    pub mime: String,
    pub encoding: &'static str,
    pub content: Option<String>,
    #[serde(rename = "isBinary")]
    pub is_binary: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".ico" => "image/x-icon",
        ".bmp" => "image/bmp",
        ".avif" => "image/avif",
        _ => return None,
    })
}

fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn safe_resolve(root: &Path, requested: &str) -> Option<PathBuf> {
    let cleaned = requested.trim_start_matches(|c| c == '/' || c == '\\');
    let combined = root.join(cleaned);
    let normalized = normalize_path(&combined);
    if normalized != root && !normalized.starts_with(root) {
        return None;
    }
    Some(normalized)
}

pub async fn read_file_safe(root: &Path, rel_path: &str) -> Option<FileResult> {
    let abs = safe_resolve(root, rel_path)?;
    let meta = tokio::fs::metadata(&abs).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let ext_raw = Path::new(rel_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let ext = if ext_raw.is_empty() {
        String::new()
    } else {
        format!(".{}", ext_raw)
    };
    let mime_image = image_mime(&ext);
    if let Some(mime) = mime_image {
        if meta.len() > IMAGE_LIMIT_BYTES {
            return Some(FileResult {
                path: rel_path.to_string(),
                size: meta.len(),
                mime: mime.to_string(),
                encoding: "base64",
                content: None,
                is_binary: true,
                truncated: true,
                reason: Some(format!("Image larger than {} bytes", IMAGE_LIMIT_BYTES)),
            });
        }
        let bytes = tokio::fs::read(&abs).await.ok()?;
        return Some(FileResult {
            path: rel_path.to_string(),
            size: meta.len(),
            mime: mime.to_string(),
            encoding: "base64",
            content: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            is_binary: true,
            truncated: false,
            reason: None,
        });
    }
    if meta.len() > TEXT_LIMIT_BYTES {
        return Some(FileResult {
            path: rel_path.to_string(),
            size: meta.len(),
            mime: "application/octet-stream".into(),
            encoding: "utf8",
            content: None,
            is_binary: false,
            truncated: true,
            reason: Some(format!("File larger than {} bytes", TEXT_LIMIT_BYTES)),
        });
    }
    let bytes = tokio::fs::read(&abs).await.ok()?;
    if looks_binary(&bytes) {
        return Some(FileResult {
            path: rel_path.to_string(),
            size: meta.len(),
            mime: "application/octet-stream".into(),
            encoding: "base64",
            content: None,
            is_binary: true,
            truncated: false,
            reason: Some("Binary file".into()),
        });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(FileResult {
            path: rel_path.to_string(),
            size: meta.len(),
            mime: "text/plain; charset=utf-8".into(),
            encoding: "utf8",
            content: Some(text),
            is_binary: false,
            truncated: false,
            reason: None,
        }),
        Err(_) => Some(FileResult {
            path: rel_path.to_string(),
            size: meta.len(),
            mime: "application/octet-stream".into(),
            encoding: "base64",
            content: None,
            is_binary: true,
            truncated: false,
            reason: Some("Binary file".into()),
        }),
    }
}

fn looks_binary(buf: &[u8]) -> bool {
    let limit = buf.len().min(8192);
    buf[..limit].iter().any(|&b| b == 0)
}
