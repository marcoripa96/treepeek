use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const READY_TIMEOUT_MS: u64 = 60_000;
const FUNNEL_PUBLIC_PORT: u16 = 443;

pub struct TunnelHandle {
    pub url: String,
    pub kind: TunnelKind,
    proc: Option<Child>,
    funnel_path: Option<String>,
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
            // Only remove our own path mapping so other treepeek instances (or
            // unrelated funnels) on this device stay intact.
            let mut args: Vec<String> = vec![
                "funnel".into(),
                format!("--https={}", FUNNEL_PUBLIC_PORT),
            ];
            if let Some(p) = self.funnel_path.as_deref() {
                if !p.is_empty() {
                    args.push(format!("--set-path={}", p));
                }
            }
            args.push("off".into());
            let _ = Command::new("tailscale")
                .args(&args)
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
        funnel_path: None,
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

/// Starts a tailscale funnel mapping at the chosen base path, on the fixed
/// public port 443. `base_path` is the leading-slash prefix (e.g. "/treepeek")
/// or empty to mount at site root. Returns an error early if the same prefix
/// is already funneled on this device.
pub async fn start_tailscale_funnel(
    port: u16,
    base_path: &str,
) -> Result<TunnelHandle, String> {
    let hostname = match get_tailscale_hostname().await {
        Ok(h) => h,
        Err(e) => return Err(format!("Tailscale not available: {}", e)),
    };

    if !base_path.is_empty() {
        if let Some(existing) = funnel_path_in_use(FUNNEL_PUBLIC_PORT, base_path).await {
            return Err(format!(
                "tailscale funnel path {} already in use on this node (currently proxying {}); pick a different directory name or `tailscale funnel --https={} --set-path={} off`",
                base_path, existing, FUNNEL_PUBLIC_PORT, base_path
            ));
        }
    }

    let target = if base_path.is_empty() {
        format!("http://localhost:{}", port)
    } else {
        // Pass the path through to the local service so the server sees the
        // prefix and the SPA's relative URLs resolve under it.
        format!("http://localhost:{}{}", port, base_path)
    };
    let mut args: Vec<String> = vec![
        "funnel".into(),
        "--bg".into(),
        format!("--https={}", FUNNEL_PUBLIC_PORT),
    ];
    if !base_path.is_empty() {
        args.push(format!("--set-path={}", base_path));
    }
    args.push(target);

    let out = Command::new("tailscale")
        .args(&args)
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
    let public_url = if FUNNEL_PUBLIC_PORT == 443 {
        format!("https://{}{}", hostname, base_path)
    } else {
        format!("https://{}:{}{}", hostname, FUNNEL_PUBLIC_PORT, base_path)
    };
    Ok(TunnelHandle {
        url: public_url,
        kind: TunnelKind::TailscaleFunnel,
        proc: None,
        funnel_path: Some(base_path.to_string()),
    })
}

/// Returns the existing proxy target if `tailscale funnel status --json`
/// already has a handler at the given path on the given public port.
async fn funnel_path_in_use(public_port: u16, base_path: &str) -> Option<String> {
    let out = Command::new("tailscale")
        .args(["funnel", "status", "--json"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let web = v.get("Web")?.as_object()?;
    for (host_port, cfg) in web {
        if !host_port.ends_with(&format!(":{}", public_port)) {
            continue;
        }
        let handlers = cfg.get("Handlers").and_then(|h| h.as_object())?;
        if let Some(h) = handlers.get(base_path) {
            return Some(
                h.get("Proxy")
                    .and_then(|p| p.as_str())
                    .unwrap_or("(unknown)")
                    .to_string(),
            );
        }
    }
    None
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
