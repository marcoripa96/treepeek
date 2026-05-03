use std::path::Path;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitStatus {
    Added,
    Deleted,
    Ignored,
    Modified,
    Renamed,
    Untracked,
}

#[derive(Serialize, Clone, Debug)]
pub struct GitStatusEntry {
    pub path: String,
    pub status: GitStatus,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum GitHistoryStatus {
    Added,
    Deleted,
    Ignored,
    Modified,
    Renamed,
    Untracked,
    Copied,
    Typechange,
    Unknown,
}

#[derive(Serialize, Clone, Debug)]
pub struct GitHistoryEntry {
    pub path: String,
    pub status: GitHistoryStatus,
    #[serde(rename = "commitHash")]
    pub commit_hash: Option<String>,
    #[serde(rename = "commitShortHash")]
    pub commit_short_hash: Option<String>,
    pub subject: String,
    pub author: String,
    pub date: Option<String>,
    #[serde(rename = "relativeDate")]
    pub relative_date: Option<String>,
    pub pending: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct CommitInfo {
    pub hash: String,
    #[serde(rename = "shortHash")]
    pub short_hash: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: String,
    #[serde(rename = "relativeDate")]
    pub relative_date: String,
}

pub fn is_repo(root: &Path) -> bool {
    root.join(".git").exists()
}

async fn run_git_text(args: &[&str], cwd: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("-C").arg(cwd);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

pub async fn last_commit(root: &Path) -> Option<CommitInfo> {
    if !is_repo(root) {
        return None;
    }
    let fmt = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%s%x1f%b";
    let pretty = format!("--pretty=format:{}", fmt);
    let s = run_git_text(&["log", "-1", &pretty], root).await?;
    let parts: Vec<&str> = s.split('\x1f').collect();
    if parts.len() < 8 {
        return None;
    }
    Some(CommitInfo {
        hash: parts[0].into(),
        short_hash: parts[1].into(),
        author: parts[2].into(),
        email: parts[3].into(),
        date: parts[4].into(),
        relative_date: parts[5].into(),
        subject: parts[6].into(),
        body: parts[7].trim_end().into(),
    })
}

pub async fn recent_commits(root: &Path, n: usize) -> Vec<CommitInfo> {
    if !is_repo(root) {
        return vec![];
    }
    let fmt = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%s%x1f%b";
    let pretty = format!("--pretty=format:{}", fmt);
    let limit = format!("-{}", n.max(1));
    let sep = "\x1e"; // record separator between commits
    let pretty_with_sep = format!("{}%x1e", pretty);
    let s = match run_git_text(&["log", &limit, &pretty_with_sep], root).await {
        Some(s) => s,
        None => return vec![],
    };
    let mut out = Vec::new();
    for record in s.split(sep) {
        let record = record.trim_matches(|c: char| c == '\n' || c == '\r');
        if record.is_empty() {
            continue;
        }
        let parts: Vec<&str> = record.split('\x1f').collect();
        if parts.len() < 8 {
            continue;
        }
        out.push(CommitInfo {
            hash: parts[0].into(),
            short_hash: parts[1].into(),
            author: parts[2].into(),
            email: parts[3].into(),
            date: parts[4].into(),
            relative_date: parts[5].into(),
            subject: parts[6].into(),
            body: parts[7].trim_end().into(),
        });
        if out.len() >= n {
            break;
        }
    }
    out
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
}

pub async fn ahead_behind(root: &Path) -> Option<AheadBehind> {
    if !is_repo(root) {
        return None;
    }
    let upstream = run_git_text(
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        root,
    )
    .await
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    let upstream = upstream?;
    let counts = run_git_text(&["rev-list", "--count", "--left-right", "@{u}...HEAD"], root)
        .await?;
    let parts: Vec<&str> = counts.split_whitespace().collect();
    if parts.len() != 2 {
        return None;
    }
    let behind: u32 = parts[0].parse().ok()?;
    let ahead: u32 = parts[1].parse().ok()?;
    Some(AheadBehind {
        ahead,
        behind,
        upstream: Some(upstream),
    })
}

pub async fn current_branch(root: &Path) -> Option<String> {
    if !is_repo(root) {
        return None;
    }
    if let Some(s) = run_git_text(&["symbolic-ref", "--short", "HEAD"], root).await {
        let v = s.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    if let Some(s) = run_git_text(&["rev-parse", "--short", "HEAD"], root).await {
        let v = s.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    None
}

pub async fn git_status(root: &Path) -> Option<Vec<GitStatusEntry>> {
    if !is_repo(root) {
        return None;
    }
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_porcelain_v1_z(&out.stdout))
}

fn classify(xy: &[u8]) -> GitStatus {
    let x = xy.first().copied().unwrap_or(b' ');
    let y = xy.get(1).copied().unwrap_or(b' ');
    if x == b'?' && y == b'?' {
        return GitStatus::Untracked;
    }
    if x == b'!' || y == b'!' {
        return GitStatus::Ignored;
    }
    if x == b'R' || y == b'R' {
        return GitStatus::Renamed;
    }
    if x == b'A' || y == b'A' {
        return GitStatus::Added;
    }
    if x == b'D' || y == b'D' {
        return GitStatus::Deleted;
    }
    GitStatus::Modified
}

fn parse_porcelain_v1_z(out: &[u8]) -> Vec<GitStatusEntry> {
    let mut entries = Vec::new();
    let mut i = 0;
    while i < out.len() {
        let nul = match out[i..].iter().position(|&b| b == 0) {
            Some(p) => i + p,
            None => break,
        };
        let tok = &out[i..nul];
        i = nul + 1;
        if tok.len() < 4 {
            continue;
        }
        let xy = &tok[0..2];
        let path_bytes = &tok[3..];
        if xy[0] == b'R' || xy[1] == b'R' {
            if let Some(p) = out[i..].iter().position(|&b| b == 0) {
                i += p + 1;
            }
        }
        let status = classify(xy);
        let path = String::from_utf8_lossy(path_bytes).into_owned();
        entries.push(GitStatusEntry { path, status });
    }
    entries
}
