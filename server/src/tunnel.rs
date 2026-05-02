use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const READY_TIMEOUT_MS: u64 = 60_000;

pub struct TunnelHandle {
    pub url: String,
    pub kind: TunnelKind,
    proc: Option<Child>,
}

#[derive(Clone, Copy)]
pub enum TunnelKind {
    Cloudflared,
    TailscaleFunnel,
}

impl TunnelHandle {
    pub async fn stop(mut self) {
        if let Some(mut proc) = self.proc.take() {
            let _ = proc.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), proc.wait()).await;
        }
        if matches!(self.kind, TunnelKind::TailscaleFunnel) {
            let _ = Command::new("tailscale")
                .args(["funnel", "reset"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }
}

pub async fn start_cloudflared_quick_tunnel(local_url: &str) -> Result<TunnelHandle, String> {
    let mut cmd = Command::new("cloudflared");
    cmd.args(["tunnel", "--no-autoupdate", "--url", local_url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(
                "cloudflared not found in PATH. Install it (e.g. `pacman -S cloudflared` on Arch) and try again."
                    .into(),
            );
        }
        Err(e) => return Err(format!("spawn cloudflared: {}", e)),
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    let tx_o = tx.clone();
    if let Some(stdout) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx_o.send(l).await;
            }
        });
    }
    let tx_e = tx.clone();
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx_e.send(l).await;
            }
        });
    }
    drop(tx);

    let deadline = tokio::time::Instant::now() + Duration::from_millis(READY_TIMEOUT_MS);
    let mut found: Option<String> = None;
    let mut combined = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(line)) => {
                combined.push_str(&line);
                combined.push('\n');
                if let Some(url) = extract_trycloudflare(&combined) {
                    found = Some(url);
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    let url = match found {
        Some(u) => u,
        None => {
            let _ = child.start_kill();
            return Err(format!(
                "cloudflared did not return a tunnel URL within {}s",
                READY_TIMEOUT_MS / 1000
            ));
        }
    };

    Ok(TunnelHandle {
        url,
        kind: TunnelKind::Cloudflared,
        proc: Some(child),
    })
}

fn extract_trycloudflare(s: &str) -> Option<String> {
    let needle = "https://";
    let mut start = 0;
    while let Some(idx) = s[start..].find(needle) {
        let begin = start + idx;
        let rest = &s[begin..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '/' || c == ':'))
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        if candidate.contains(".trycloudflare.com") {
            return Some(candidate.to_string());
        }
        start = begin + end.max(1);
    }
    None
}

pub async fn start_tailscale_funnel(port: u16) -> Result<TunnelHandle, String> {
    let hostname = match get_tailscale_hostname().await {
        Ok(h) => h,
        Err(e) => return Err(format!("Tailscale not available: {}", e)),
    };
    let out = Command::new("tailscale")
        .args(["funnel", "--bg", &port.to_string()])
        .output()
        .await
        .map_err(|e| format!("spawn tailscale: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let msg = stderr.trim().to_string();
        let msg = if msg.is_empty() { stdout.trim().to_string() } else { msg };
        return Err(if msg.is_empty() { "tailscale funnel failed".into() } else { msg });
    }
    Ok(TunnelHandle {
        url: format!("https://{}", hostname),
        kind: TunnelKind::TailscaleFunnel,
        proc: None,
    })
}

async fn get_tailscale_hostname() -> Result<String, String> {
    let out = Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .await
        .map_err(|e| format!("spawn tailscale: {}", e))?;
    if !out.status.success() {
        return Err("`tailscale status --json` failed".into());
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("parse: {}", e))?;
    let dns = v
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|n| n.as_str())
        .ok_or("Tailscale DNSName not found (is MagicDNS enabled?)")?;
    Ok(dns.trim_end_matches('.').to_string())
}
