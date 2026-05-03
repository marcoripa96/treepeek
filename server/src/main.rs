mod assets;
mod auth;
mod device_store;
mod diff;
mod file;
mod git;
mod history;
mod network;
mod outline;
mod passkey;
mod push;
mod registry;
mod search;
mod server;
mod tunnel;
mod walker;
mod watcher;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

use crate::assets::build_manifest;
use crate::auth::load_or_create_token;
use crate::device_store::DeviceStore;
use crate::history::HistoryStore;
use crate::network::{lan_ipv4, tailscale_ipv4};
use crate::passkey::PasskeyService;
use crate::push::{ensure_vapid, PushManager};
use crate::registry::{register_instance, unregister_instance, InstanceInfo};
use crate::search::SearchService;
use crate::server::{build_router, AppState};
use crate::tunnel::{start_cloudflared_quick_tunnel, start_tailscale_funnel, TunnelHandle};

#[derive(Default)]
struct CliOptions {
    port: u16,
    port_explicit: bool,
    bind: Option<String>,
    all: bool,
    token: Option<String>,
    rotate_token: bool,
    no_qr: bool,
    tunnel: bool,
    funnel: bool,
    require_auth: bool,
    help: bool,
}

fn parse_args(argv: &[String]) -> CliOptions {
    let mut opts = CliOptions {
        port: 7777,
        ..Default::default()
    };
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "--help" | "-h" => opts.help = true,
            "--port" | "-p" => {
                i += 1;
                if let Some(v) = argv.get(i) {
                    if let Ok(n) = v.parse::<u16>() {
                        opts.port = n;
                        opts.port_explicit = true;
                    }
                }
            }
            "--bind" | "-b" => {
                i += 1;
                opts.bind = argv.get(i).cloned();
            }
            "--all" => opts.all = true,
            "--token" => {
                i += 1;
                opts.token = argv.get(i).cloned();
            }
            "--rotate-token" => opts.rotate_token = true,
            "--no-qr" => opts.no_qr = true,
            "--tunnel" | "-t" => opts.tunnel = true,
            "--funnel" | "-f" => opts.funnel = true,
            "--require-auth" => opts.require_auth = true,
            other if other.starts_with('-') => {
                eprintln!("treepeek: unknown flag {}", other);
            }
            _ => {}
        }
        i += 1;
    }
    opts
}

fn print_help() {
    println!(
        "treepeek — browse a remote folder over Tailscale.

Usage:
  treepeek [options]

Options:
  -p, --port <n>       Port to listen on (default 7777, auto-incremented if taken)
  -b, --bind <ip>      Address to bind (default: tailscale0 IP, else 0.0.0.0)
      --all            Include node_modules / .git / build dirs
      --token <s>      Use a specific token (else loaded/generated)
      --rotate-token   Force a fresh token
      --no-qr          Don't print the QR code
  -t, --tunnel         Ephemeral public HTTPS URL via Cloudflare quick tunnel
                       (random *.trycloudflare.com per run; binds to 127.0.0.1)
  -f, --funnel         Stable public HTTPS URL via Tailscale Funnel
                       (https://<host>.<tailnet>.ts.net; binds to 127.0.0.1)
      --require-auth   Require token/passkey even in Tailscale-only mode
                       (default: trust the tailnet when bound to tailscale0)
  -h, --help           Show this help"
    );
}

fn print_qr(text: &str) {
    use qrcode::render::unicode;
    use qrcode::QrCode;
    let Ok(code) = QrCode::new(text.as_bytes()) else {
        return;
    };
    let s = code
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .quiet_zone(true)
        .build();
    for line in s.lines() {
        println!("  {}", line);
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let opts = parse_args(&argv);
    if opts.help {
        print_help();
        return;
    }

    if let Err(e) = run(opts).await {
        eprintln!("[treepeek] failed to start: {}", e);
        std::process::exit(1);
    }
}

async fn run(opts: CliOptions) -> Result<(), String> {
    let root: PathBuf = std::env::current_dir().map_err(|e| e.to_string())?;
    let root_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let home = std::env::var("HOME").unwrap_or_default();
    let root_str = root.to_string_lossy().into_owned();
    let display_root = if !home.is_empty() && (root_str == home || root_str.starts_with(&format!("{}/", home))) {
        format!("~{}", &root_str[home.len()..])
    } else {
        root_str.clone()
    };

    let token = load_or_create_token(opts.rotate_token, opts.token.clone())
        .map_err(|e| format!("token: {}", e))?;
    let manifest_json = build_manifest(&root_name);

    if opts.tunnel && opts.funnel {
        eprintln!("[treepeek] --tunnel and --funnel are mutually exclusive");
        std::process::exit(2);
    }

    let mut bind = opts.bind.clone();
    let mut bind_reason = "explicit".to_string();
    if (opts.tunnel || opts.funnel) && bind.is_none() {
        bind = Some("127.0.0.1".to_string());
        bind_reason = format!(
            "{} mode (loopback)",
            if opts.tunnel { "tunnel" } else { "funnel" }
        );
    } else if bind.is_none() {
        if let Some(ts) = tailscale_ipv4() {
            bind = Some(ts);
            bind_reason = "tailscale0".to_string();
        } else {
            bind = Some("0.0.0.0".to_string());
            bind_reason = "fallback (Tailscale not detected)".to_string();
        }
    }
    let bind = bind.unwrap();

    let history_store = Arc::new(
        HistoryStore::open(&root, &history_db_path(&root))
            .map_err(|e| format!("history db: {}", e))?,
    );
    let device_store = Arc::new(
        DeviceStore::open(&device_db_path(&root))
            .map_err(|e| format!("device db: {}", e))?,
    );
    device_store.cleanup_expired();

    let mut vapid_public_key: Option<String> = None;
    let push_manager = match PushManager::new(root_str.clone()) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            eprintln!(
                "[treepeek] VAPID setup failed, push notifications disabled: {:?}",
                e
            );
            Arc::new(PushManager::new(root_str.clone()).map_err(|e| format!("push: {:?}", e))?)
        }
    };
    match ensure_vapid() {
        Ok(cfg) => {
            vapid_public_key = Some(cfg.public_key.clone());
            push_manager.set_vapid(cfg).await;
            push_manager.load().await;
        }
        Err(e) => {
            eprintln!(
                "[treepeek] VAPID setup failed, push notifications disabled: {}",
                e
            );
        }
    }

    let frecency_db = frecency_db_path(&root);
    let search = match SearchService::init(&root, frecency_db) {
        Ok(s) => Some(Arc::new(s)),
        Err(e) => {
            eprintln!("[treepeek] search disabled: {}", e);
            None
        }
    };

    let auth_required = opts.require_auth || bind_reason != "tailscale0";
    let state = AppState::new(
        root.clone(),
        root_name.clone(),
        display_root.clone(),
        opts.all,
        token.clone(),
        auth_required,
        manifest_json,
        history_store.clone(),
        device_store.clone(),
        push_manager.clone(),
        vapid_public_key.clone(),
        search.clone(),
    );

    let bind_ip: IpAddr = bind
        .parse()
        .map_err(|e| format!("invalid bind address {}: {}", bind, e))?;

    let peer_claimed: std::collections::HashSet<u16> =
        crate::registry::list_instances().iter().map(|i| i.port).collect();
    let candidates: Vec<u16> = if opts.port_explicit {
        vec![opts.port]
    } else {
        (0..20)
            .map(|i| opts.port + i)
            .filter(|p| !peer_claimed.contains(p))
            .collect()
    };

    let mut listener: Option<TcpListener> = None;
    let mut bound_port: u16 = 0;
    let mut last_err: Option<std::io::Error> = None;
    for port in &candidates {
        let addr = SocketAddr::new(bind_ip, *port);
        match TcpListener::bind(addr).await {
            Ok(l) => {
                bound_port = *port;
                listener = Some(l);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let listener = listener.ok_or_else(|| {
        format!(
            "failed to bind any port near {}: {}",
            opts.port,
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown".into())
        )
    })?;

    state
        .server_port
        .set(bound_port)
        .map_err(|_| "server_port already set".to_string())?;

    let app = build_router(state.clone());

    let server_task = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[treepeek] server error: {}", e);
        }
    });

    let peer_host = if bind == "0.0.0.0" || bind == "::" {
        "127.0.0.1".to_string()
    } else {
        bind.clone()
    };
    register_instance(&InstanceInfo {
        port: bound_port,
        host: peer_host.clone(),
        root: root_str.clone(),
        display_root: display_root.clone(),
        pid: std::process::id(),
        started_at: chrono::Utc::now().timestamp_millis(),
    });

    let watcher_state = state.clone();
    let push_for_watch = push_manager.clone();
    let history_for_watch = history_store.clone();
    let vapid_present = vapid_public_key.is_some();
    let root_for_watch = root.clone();
    let root_name_for_watch = root_name.clone();
    let on_change = Arc::new(move |changed: Vec<String>| {
        history_for_watch.record_changes(&changed);
        let state = watcher_state.clone();
        let push = push_for_watch.clone();
        let root = root_for_watch.clone();
        let root_name = root_name_for_watch.clone();
        tokio::spawn(async move {
            state.invalidate_caches().await;
            state.broadcast(&json!({ "type": "changed" })).await;
            if vapid_present && push.has_subscriptions().await {
                let rel = relative_changed(&root, &changed);
                let body = describe_changes(&rel);
                let url = match rel.first() {
                    Some(f) => format!("/?file={}", urlencode(f)),
                    None => "/".to_string(),
                };
                let title = format!("treepeek · {}", root_name);
                let file_first = rel.first().map(|s| s.as_str());
                push.dispatch(&crate::push::DispatchPayload {
                    title: &title,
                    body: &body,
                    url: Some(&url),
                    file: file_first,
                })
                .await;
            }
        });
    });
    let refs_state = state.clone();
    let on_refs_change = Arc::new(move || {
        let state = refs_state.clone();
        tokio::spawn(async move {
            state.invalidate_caches().await;
            state.broadcast(&json!({ "type": "changed" })).await;
        });
    });

    let _watcher = match watcher::start(
        root.clone(),
        opts.all,
        on_change as Arc<dyn Fn(Vec<String>) + Send + Sync>,
        Some(on_refs_change as Arc<dyn Fn() + Send + Sync>),
    ) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("[treepeek] watcher unavailable: {}", e);
            None
        }
    };

    let mut tunnel_handle: Option<TunnelHandle> = None;
    let share_url: String;
    let origin_label: String;

    if opts.tunnel {
        let local = format!("http://{}:{}", peer_host, bound_port);
        println!();
        println!("  treepeek  {}", root_name);
        println!("  bind:     {}:{}  ({})", bind, bound_port, bind_reason);
        println!("  tunnel:   starting cloudflared quick tunnel ...");
        match start_cloudflared_quick_tunnel(&local).await {
            Ok(t) => {
                share_url = format!("{}/?k={}", t.url, token);
                origin_label = format!("{}  (Cloudflare quick tunnel)", t.url);
                tunnel_handle = Some(t);
            }
            Err(e) => {
                eprintln!("\n[treepeek] tunnel failed: {}", e);
                std::process::exit(1);
            }
        }
    } else if opts.funnel {
        println!();
        println!("  treepeek  {}", root_name);
        println!("  bind:     {}:{}  ({})", bind, bound_port, bind_reason);
        println!("  funnel:   configuring tailscale funnel ...");
        match start_tailscale_funnel(bound_port).await {
            Ok(t) => {
                share_url = format!("{}/?k={}", t.url, token);
                origin_label = format!("{}  (Tailscale Funnel)", t.url);
                tunnel_handle = Some(t);
            }
            Err(e) => {
                eprintln!("\n[treepeek] funnel failed: {}", e);
                eprintln!("  hint: enable Funnel/HTTPS at https://login.tailscale.com/admin/settings");
                std::process::exit(1);
            }
        }
    } else {
        let display_host = if bind == "0.0.0.0" || bind == "::" {
            tailscale_ipv4()
                .or_else(lan_ipv4)
                .unwrap_or_else(|| "127.0.0.1".to_string())
        } else {
            bind.clone()
        };
        share_url = format!("http://{}:{}/?k={}", display_host, bound_port, token);
        origin_label = format!("http://{}:{}", display_host, bound_port);
        println!();
        println!("  treepeek  {}", root_name);
        println!("  bind:     {}:{}  ({})", bind, bound_port, bind_reason);
    }

    if let Some(t) = tunnel_handle.as_ref() {
        match init_passkey_service(&t.url) {
            Ok(svc) => {
                let _ = state.passkey.set(Arc::new(svc));
            }
            Err(e) => {
                eprintln!("[treepeek] passkey unavailable: {}", e);
            }
        }
    }

    println!();
    println!("  open on your phone:");
    println!("    \x1b[36m{}\x1b[0m", share_url);
    println!();
    if !opts.no_qr {
        print_qr(&share_url);
    }
    if tunnel_handle.is_some() {
        println!("  origin:   {}", origin_label);
    }
    println!("  ctrl-c to stop");
    println!();

    let mut sigint = signal(SignalKind::interrupt()).map_err(|e| e.to_string())?;
    let mut sigterm = signal(SignalKind::terminate()).map_err(|e| e.to_string())?;
    tokio::select! {
        _ = sigint.recv() => println!("\n[treepeek] caught SIGINT, shutting down ..."),
        _ = sigterm.recv() => println!("\n[treepeek] caught SIGTERM, shutting down ..."),
        _ = server_task => {},
    }

    unregister_instance(bound_port);
    if let Some(s) = search.as_ref() {
        s.shutdown();
    }
    if let Some(t) = tunnel_handle {
        t.stop().await;
    }
    Ok(())
}

fn per_root_cache_dir(root: &std::path::Path) -> Option<PathBuf> {
    let cache = std::env::var("XDG_CACHE_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".cache")))?;
    let abs = root.to_string_lossy();
    let mut h: u64 = 5381;
    for b in abs.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    Some(cache.join("treepeek").join(format!("{:016x}", h)))
}

fn frecency_db_path(root: &std::path::Path) -> Option<PathBuf> {
    Some(per_root_cache_dir(root)?.join("frecency"))
}

fn history_db_path(root: &std::path::Path) -> PathBuf {
    per_root_cache_dir(root)
        .map(|d| d.join("history.sqlite"))
        .unwrap_or_else(|| PathBuf::from("/tmp/treepeek-history.sqlite"))
}

fn device_db_path(root: &std::path::Path) -> PathBuf {
    per_root_cache_dir(root)
        .map(|d| d.join("devices.sqlite"))
        .unwrap_or_else(|| PathBuf::from("/tmp/treepeek-devices.sqlite"))
}

fn init_passkey_service(origin_url: &str) -> Result<PasskeyService, String> {
    let parsed = url::Url::parse(origin_url).map_err(|e| format!("bad origin url: {}", e))?;
    let rp_id = parsed
        .host_str()
        .ok_or_else(|| "origin url missing host".to_string())?
        .to_string();
    PasskeyService::new(&rp_id, &parsed).map_err(|e| format!("webauthn init: {}", e))
}

fn relative_changed(root: &std::path::Path, paths: &[String]) -> Vec<String> {
    let prefix = format!("{}/", root.to_string_lossy());
    paths
        .iter()
        .filter_map(|p| {
            if p.starts_with(&prefix) {
                Some(p[prefix.len()..].to_string())
            } else {
                None
            }
        })
        .filter(|p| !p.is_empty())
        .collect()
}

fn describe_changes(rel: &[String]) -> String {
    if rel.is_empty() {
        return "Files changed".into();
    }
    if rel.len() == 1 {
        return rel[0].clone();
    }
    if rel.len() <= 3 {
        return rel.join(", ");
    }
    format!("{} and {} more", rel[0], rel.len() - 1)
}

fn urlencode(s: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}
