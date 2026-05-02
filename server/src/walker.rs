use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

const DEFAULT_IGNORES: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    ".turbo",
    ".cache",
    "dist",
    "build",
    ".svelte-kit",
    ".nuxt",
    "coverage",
    ".vercel",
    ".output",
    ".parcel-cache",
    "out",
    ".angular",
    ".idea",
    ".vscode",
    "__pycache__",
    ".venv",
    "venv",
    "target",
];

#[derive(Serialize)]
pub struct WalkResult {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub count: usize,
}

pub fn walk(root: &Path, include_all: bool, max_entries: usize) -> WalkResult {
    let ignores: BTreeSet<&str> = if include_all {
        BTreeSet::new()
    } else {
        DEFAULT_IGNORES.iter().copied().collect()
    };
    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];

    'outer: while let Some(dir) = stack.pop() {
        if out.len() >= max_entries {
            truncated = true;
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut items: Vec<(String, bool)> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if ignores.contains(name_str) {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            items.push((name_str.to_string(), ft.is_dir()));
        }
        items.sort_by(|a, b| {
            if a.1 != b.1 {
                return if a.1 {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
            a.0.cmp(&b.0)
        });
        for (name, is_dir) in &items {
            if out.len() >= max_entries {
                truncated = true;
                break 'outer;
            }
            let abs = dir.join(name);
            let rel = abs
                .strip_prefix(root)
                .unwrap_or(&abs)
                .to_string_lossy()
                .replace('\\', "/");
            if *is_dir {
                out.push(format!("{}/", rel));
                stack.push(abs);
            } else {
                out.push(rel);
            }
        }
    }
    WalkResult {
        count: out.len(),
        paths: out,
        truncated,
    }
}
