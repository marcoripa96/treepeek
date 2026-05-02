use std::path::Path;

use serde::Serialize;

use crate::file::safe_resolve;

#[derive(Serialize)]
pub struct DiffResult {
    pub path: String,
    pub patch: String,
    #[serde(rename = "hasChanges")]
    pub has_changes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub async fn get_file_diff(root: &Path, rel_path: &str) -> Option<DiffResult> {
    let abs = safe_resolve(root, rel_path)?;
    if !root.join(".git").exists() {
        return Some(DiffResult {
            path: rel_path.into(),
            patch: "".into(),
            has_changes: false,
            reason: Some("Not a git repository".into()),
        });
    }
    let tracked = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "diff.mnemonicPrefix=false",
            "-c",
            "diff.noprefix=false",
            "diff",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "HEAD",
            "--",
            rel_path,
        ])
        .output()
        .await
        .ok()?;
    if tracked.status.success() && !tracked.stdout.is_empty() {
        let patch = String::from_utf8_lossy(&tracked.stdout).into_owned();
        return Some(DiffResult {
            path: rel_path.into(),
            patch,
            has_changes: true,
            reason: None,
        });
    }
    let is_tracked = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--error-unmatch", "--", rel_path])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_tracked {
        if let Some(s) = build_synthetic_new_file_diff(&abs, rel_path).await {
            return Some(DiffResult {
                path: rel_path.into(),
                patch: s,
                has_changes: true,
                reason: None,
            });
        }
    }
    Some(DiffResult {
        path: rel_path.into(),
        patch: "".into(),
        has_changes: false,
        reason: None,
    })
}

async fn build_synthetic_new_file_diff(abs: &Path, rel_path: &str) -> Option<String> {
    let bytes = tokio::fs::read(abs).await.ok()?;
    let limit = bytes.len().min(8192);
    if bytes[..limit].iter().any(|&b| b == 0) {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    let mut lines: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    };
    if matches!(lines.last(), Some(&"")) {
        lines.pop();
    }
    let count = lines.len().max(1);
    let mut out = String::new();
    out.push_str(&format!(
        "diff --git a/{p} b/{p}\nnew file mode 100644\n--- /dev/null\n+++ b/{p}\n@@ -0,0 +1,{c} @@\n",
        p = rel_path,
        c = count
    ));
    if lines.is_empty() {
        out.push_str("+\n");
    } else {
        for l in &lines {
            out.push('+');
            out.push_str(l);
            out.push('\n');
        }
    }
    Some(out)
}
