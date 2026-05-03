use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::assets::{
    EmbeddedAsset, CLIENT_ASSETS, ICON_PNG_192, ICON_PNG_512, ICON_SVG, SERVICE_WORKER_JS,
};
use crate::auth::is_authenticated;
use crate::device_store::DeviceStore;
use crate::diff::get_file_diff;
use crate::file::read_file_safe;
use crate::git::{self, GitHistoryEntry};
use crate::history::HistoryStore;
use crate::outline;
use crate::passkey::PasskeyService;
use crate::push::{is_valid_subscription, PushManager, PushSubscriptionPayload};
use crate::registry::list_instances;
use crate::search::SearchService;
use crate::walker::walk;
use crate::watcher::EventRing;

const TREE_CACHE_TTL: Duration = Duration::from_millis(5_000);
const MAX_WALK_ENTRIES: usize = 50_000;
pub const SESSION_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 30);
pub const SESSION_COOKIE: &str = "tp_session";
pub const INTERNAL_HEADER: &str = "x-treepeek-internal";

type SharedState = Arc<AppState>;

pub struct AppState {
    pub root: PathBuf,
    pub root_name: String,
    pub display_root: String,
    pub include_all: bool,
    pub token: String,
    pub auth_required: bool,
    pub manifest_json: String,
    pub history_store: Arc<HistoryStore>,
    pub device_store: Arc<DeviceStore>,
    pub passkey: tokio::sync::OnceCell<Arc<PasskeyService>>,
    pub push_manager: Arc<PushManager>,
    pub vapid_public_key: Option<String>,
    pub search: Option<Arc<SearchService>>,
    pub server_port: tokio::sync::OnceCell<u16>,
    pub sockets: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    pub fs_ring: Arc<EventRing>,
    tree_cache: RwLock<Option<(Instant, JsonValue)>>,
    history_cache: RwLock<Option<(Instant, Vec<GitHistoryEntry>)>>,
}

impl AppState {
    pub fn new(
        root: PathBuf,
        root_name: String,
        display_root: String,
        include_all: bool,
        token: String,
        auth_required: bool,
        manifest_json: String,
        history_store: Arc<HistoryStore>,
        device_store: Arc<DeviceStore>,
        push_manager: Arc<PushManager>,
        vapid_public_key: Option<String>,
        search: Option<Arc<SearchService>>,
        fs_ring: Arc<EventRing>,
    ) -> Arc<Self> {
        Arc::new(Self {
            root,
            root_name,
            display_root,
            include_all,
            token,
            auth_required,
            manifest_json,
            history_store,
            device_store,
            passkey: tokio::sync::OnceCell::new(),
            push_manager,
            vapid_public_key,
            search,
            server_port: tokio::sync::OnceCell::new(),
            sockets: Mutex::new(Vec::new()),
            fs_ring,
            tree_cache: RwLock::new(None),
            history_cache: RwLock::new(None),
        })
    }

    /// Authenticated for data access — only via tailnet trust, valid session
    /// cookie, or the internal proxy header. The master token (?k=) does NOT
    /// grant data access; it only authorizes the pairing flow.
    pub fn request_authenticated(
        &self,
        cookie_header: Option<&str>,
        internal_header: Option<&str>,
    ) -> bool {
        if !self.auth_required {
            return true;
        }
        if let Some(h) = internal_header {
            if crate::auth::token_matches(Some(h), &self.token) {
                return true;
            }
        }
        if let Some(sid) = crate::auth::read_cookie(cookie_header, SESSION_COOKIE) {
            if let Some(device_id) = self.device_store.validate_session(&sid) {
                self.device_store.renew_session(&sid, SESSION_TTL);
                self.device_store.touch_device(device_id);
                return true;
            }
        }
        false
    }

    /// Authorized to pair a new device. Accepts the master token via ?k= or
    /// cookie (the QR-handed credential), an existing valid session, or the
    /// internal proxy header.
    pub fn can_register_device(
        &self,
        query_k: Option<&str>,
        cookie_header: Option<&str>,
        internal_header: Option<&str>,
    ) -> bool {
        if !self.auth_required {
            return true;
        }
        if self.request_authenticated(cookie_header, internal_header) {
            return true;
        }
        if is_authenticated(query_k, cookie_header, &self.token) {
            return true;
        }
        false
    }

    pub async fn invalidate_caches(&self) {
        *self.tree_cache.write().await = None;
        *self.history_cache.write().await = None;
    }

    pub async fn broadcast(&self, payload: &JsonValue) {
        let msg = payload.to_string();
        let mut g = self.sockets.lock().await;
        g.retain(|tx| tx.send(msg.clone()).is_ok());
    }
}

pub fn build_router(state: SharedState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/auth/register/start", post(auth_register_start))
        .route("/api/auth/register/finish", post(auth_register_finish))
        .route("/api/auth/login/start", post(auth_login_start))
        .route("/api/auth/login/finish", post(auth_login_finish))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/auth/status", get(auth_status))
        .route("/api/devices", get(list_devices))
        .route("/api/devices/:id", delete(delete_device))
        .fallback(catch_all)
        .with_state(state)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let internal = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok());
    if !state.request_authenticated(cookie, internal) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let peer_port: Option<u16> = params.get("ws").and_then(|s| s.parse().ok());
    let server_port = *state.server_port.get().unwrap_or(&0);
    if let Some(pp) = peer_port {
        if pp != server_port {
            let peer = list_instances().into_iter().find(|i| i.port == pp);
            let token = state.token.clone();
            return ws.on_upgrade(move |socket| async move {
                if let Some(peer) = peer {
                    proxy_ws(socket, peer.host, peer.port, token).await;
                }
            });
        }
    }
    ws.on_upgrade(move |socket| async move {
        handle_local_ws(socket, state).await;
    })
}

async fn handle_local_ws(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut g = state.sockets.lock().await;
        g.push(tx);
    }
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(WsMessage::Text(msg)).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        if matches!(msg, WsMessage::Close(_)) {
            break;
        }
    }
    send_task.abort();
}

async fn proxy_ws(client: WebSocket, host: String, port: u16, token: String) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let url = format!("ws://{}:{}/ws", host, port);
    let mut req = match url.into_client_request() {
        Ok(r) => r,
        Err(_) => return,
    };
    req.headers_mut()
        .insert(INTERNAL_HEADER, token.parse().unwrap());
    let peer = match tokio_tungstenite::connect_async(req).await {
        Ok((s, _)) => s,
        Err(_) => return,
    };
    let (mut peer_sink, mut peer_stream) = peer.split();
    let (mut client_sink, mut client_stream) = client.split();
    let c_to_p = async move {
        while let Some(Ok(msg)) = client_stream.next().await {
            let Some(t_msg) = axum_to_tungstenite(msg) else { break };
            if peer_sink.send(t_msg).await.is_err() {
                break;
            }
        }
    };
    let p_to_c = async move {
        while let Some(Ok(msg)) = peer_stream.next().await {
            let Some(a_msg) = tungstenite_to_axum(msg) else { break };
            if client_sink.send(a_msg).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = c_to_p => {}
        _ = p_to_c => {}
    }
}

fn axum_to_tungstenite(m: WsMessage) -> Option<tokio_tungstenite::tungstenite::Message> {
    use tokio_tungstenite::tungstenite::Message as T;
    Some(match m {
        WsMessage::Text(s) => T::Text(s),
        WsMessage::Binary(b) => T::Binary(b),
        WsMessage::Ping(b) => T::Ping(b),
        WsMessage::Pong(b) => T::Pong(b),
        WsMessage::Close(_) => return None,
    })
}

fn tungstenite_to_axum(m: tokio_tungstenite::tungstenite::Message) -> Option<WsMessage> {
    use tokio_tungstenite::tungstenite::Message as T;
    Some(match m {
        T::Text(s) => WsMessage::Text(s),
        T::Binary(b) => WsMessage::Binary(b),
        T::Ping(b) => WsMessage::Ping(b),
        T::Pong(b) => WsMessage::Pong(b),
        T::Close(_) => return None,
        T::Frame(_) => return None,
    })
}

fn unauthorized(req: &Request<Body>) -> Response {
    let path = req.uri().path();
    let accepts_json = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("application/json"))
        .unwrap_or(false);
    if accepts_json || path.starts_with("/api/") {
        return (
            StatusCode::UNAUTHORIZED,
            json_response(&json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    let html = r#"<!DOCTYPE html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>treepeek</title><body style="background:#0b0d10;color:#94a3b8;font:14px system-ui;margin:0;display:grid;place-items:center;height:100vh;text-align:center;padding:24px"><div><h1 style="color:#e5e7eb;font-size:18px;margin:0 0 8px">Authentication required</h1><p>Open the share URL printed by <code>treepeek</code> on the host.</p></div></body>"#;
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(html))
        .unwrap()
}

fn json_response(v: &JsonValue) -> Response {
    let body = v.to_string();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

fn parse_query(uri: &http::Uri) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(q) = uri.query() {
        for pair in q.split('&') {
            if pair.is_empty() {
                continue;
            }
            let mut it = pair.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            let k = percent_encoding::percent_decode_str(k).decode_utf8_lossy().into_owned();
            let v = percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned();
            out.insert(k, v);
        }
    }
    out
}

async fn catch_all(State(state): State<SharedState>, req: Request<Body>) -> Response {
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let method = req.method().clone();
    let query = parse_query(&uri);
    let cookie_header = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if path == "/icon.svg" {
        return raw_response(ICON_SVG, "image/svg+xml", "public, max-age=86400");
    }
    if path == "/icon-192.png" {
        return raw_response(ICON_PNG_192, "image/png", "public, max-age=86400");
    }
    if path == "/icon-512.png" {
        return raw_response(ICON_PNG_512, "image/png", "public, max-age=86400");
    }
    if path == "/manifest.webmanifest" {
        return raw_response(
            state.manifest_json.clone(),
            "application/manifest+json",
            "public, max-age=300",
        );
    }

    // Static client assets (HTML, JS, CSS, images) are public — they contain no
    // user data. The React app handles its own auth via /api/auth/* endpoints.
    // The ?k= in URL is a pairing token for the WebAuthn registration flow only.
    let asset_path: &str = if path == "/index.html" { "/" } else { &path };
    if let Some(asset) = find_asset(asset_path) {
        return serve_asset(&req, asset);
    }

    if path == "/sw.js" {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(SERVICE_WORKER_JS))
            .unwrap();
    }

    // Everything below this line is data-bearing — gate behind a real session.
    let internal_header = req
        .headers()
        .get(INTERNAL_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if !state.request_authenticated(cookie_header.as_deref(), internal_header.as_deref()) {
        return unauthorized(&req);
    }

    if path == "/api/push/key" {
        if let Some(pk) = &state.vapid_public_key {
            return json_response(&json!({ "publicKey": pk }));
        }
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            json_response(&json!({ "error": "push unavailable" })),
        )
            .into_response();
    }
    if path == "/api/push/subscribe" && method == Method::POST {
        if state.vapid_public_key.is_none() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                json_response(&json!({ "error": "push unavailable" })),
            )
                .into_response();
        }
        let bytes = match read_full_body(req).await {
            Some(b) => b,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "bad request" })),
                )
                    .into_response();
            }
        };
        let value: JsonValue = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "bad request" })),
                )
                    .into_response();
            }
        };
        if !is_valid_subscription(&value) {
            return (
                StatusCode::BAD_REQUEST,
                json_response(&json!({ "error": "invalid subscription" })),
            )
                .into_response();
        }
        let sub: PushSubscriptionPayload = match serde_json::from_value(value) {
            Ok(s) => s,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "invalid subscription" })),
                )
                    .into_response();
            }
        };
        state.push_manager.add_subscription(sub).await;
        return json_response(&json!({ "ok": true }));
    }
    if path == "/api/push/unsubscribe" && method == Method::POST {
        let bytes = match read_full_body(req).await {
            Some(b) => b,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "bad request" })),
                )
                    .into_response();
            }
        };
        #[derive(Deserialize)]
        struct Body {
            endpoint: Option<String>,
        }
        let parsed: Body = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "bad request" })),
                )
                    .into_response();
            }
        };
        let endpoint = match parsed.endpoint {
            Some(e) => e,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "missing endpoint" })),
                )
                    .into_response();
            }
        };
        state.push_manager.remove_subscription(&endpoint).await;
        return json_response(&json!({ "ok": true }));
    }

    if path == "/api/instances" {
        let server_port = *state.server_port.get().unwrap_or(&0);
        let list: Vec<JsonValue> = list_instances()
            .into_iter()
            .map(|i| {
                json!({
                    "port": i.port,
                    "displayRoot": i.display_root,
                    "root": i.root,
                    "isSelf": i.port == server_port,
                })
            })
            .collect();
        return json_response(&json!({
            "instances": list,
            "selfPort": server_port,
        }));
    }

    let ws_param: Option<u16> = query.get("ws").and_then(|s| s.parse().ok());
    let server_port = *state.server_port.get().unwrap_or(&0);
    if let Some(pp) = ws_param {
        if pp != server_port
            && (path == "/api/tree"
                || path == "/api/history"
                || path == "/api/file"
                || path == "/api/diff"
                || path == "/api/search"
                || path == "/api/outline"
                || path == "/api/pulse")
        {
            return proxy_http(method, &path, &uri, pp, &state.token, cookie_header.as_deref())
                .await;
        }
    }

    if path == "/api/tree" {
        let data = compute_tree(&state).await;
        return json_response(&data);
    }
    if path == "/api/pulse" {
        let data = compute_pulse(&state).await;
        return json_response(&data);
    }
    if path == "/api/history" {
        let data = compute_history(&state).await;
        return json_response(&json!({ "entries": data }));
    }
    if path == "/api/file" {
        let p = match query.get("p") {
            Some(p) => p.clone(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "missing path" })),
                )
                    .into_response();
            }
        };
        return match read_file_safe(&state.root, &p).await {
            Some(d) => {
                if let Some(search) = state.search.as_ref() {
                    let s = search.clone();
                    let p2 = p.clone();
                    tokio::task::spawn_blocking(move || s.track_access(&p2));
                }
                json_response(&serde_json::to_value(d).unwrap_or(JsonValue::Null))
            }
            None => (
                StatusCode::NOT_FOUND,
                json_response(&json!({ "error": "not found" })),
            )
                .into_response(),
        };
    }
    if path == "/api/search" {
        let q = query.get("q").cloned().unwrap_or_default();
        let limit: usize = query
            .get("limit")
            .and_then(|s| s.parse().ok())
            .unwrap_or(50)
            .clamp(1, 500);
        let Some(search) = state.search.clone() else {
            return json_response(&json!({ "results": [] }));
        };
        let hits = tokio::task::spawn_blocking(move || search.search(&q, limit))
            .await
            .unwrap_or_default();
        return json_response(&json!({ "results": hits }));
    }
    if path == "/api/outline" {
        let p = match query.get("p") {
            Some(p) => p.clone(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "missing path" })),
                )
                    .into_response();
            }
        };
        let file = match read_file_safe(&state.root, &p).await {
            Some(f) => f,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    json_response(&json!({ "error": "not found" })),
                )
                    .into_response();
            }
        };
        let Some(content) = file.content.clone() else {
            return json_response(&json!({ "symbols": [], "links": [] }));
        };
        if file.is_binary || file.truncated {
            return json_response(&json!({ "symbols": [], "links": [] }));
        }
        let tree = compute_tree(&state).await;
        let paths: HashSet<String> = tree
            .get("paths")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| !s.ends_with('/'))
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let outline = tokio::task::spawn_blocking(move || outline::build(&content, &p, &paths))
            .await
            .unwrap_or_default();
        return json_response(&serde_json::to_value(outline).unwrap_or(JsonValue::Null));
    }
    if path == "/api/diff" {
        let p = match query.get("p") {
            Some(p) => p.clone(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    json_response(&json!({ "error": "missing path" })),
                )
                    .into_response();
            }
        };
        return match get_file_diff(&state.root, &p).await {
            Some(d) => json_response(&serde_json::to_value(d).unwrap_or(JsonValue::Null)),
            None => (
                StatusCode::NOT_FOUND,
                json_response(&json!({ "error": "not found" })),
            )
                .into_response(),
        };
    }

    (StatusCode::NOT_FOUND, "Not found").into_response()
}

fn find_asset(path: &str) -> Option<&'static EmbeddedAsset> {
    CLIENT_ASSETS.iter().find(|a| a.url == path)
}

fn serve_asset(req: &Request<Body>, asset: &'static EmbeddedAsset) -> Response {
    let if_none_match = req
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    if matches!(if_none_match, Some(v) if v == asset.etag) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, asset.etag)
            .header(
                header::CACHE_CONTROL,
                "public, max-age=300, must-revalidate",
            )
            .body(Body::empty())
            .unwrap();
    }
    let accept_enc = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let use_br = accept_enc.contains("br");
    let (body, enc): (&'static [u8], &'static str) = if use_br {
        (asset.br, "br")
    } else {
        (asset.gz, "gzip")
    };
    let is_html = asset.content_type.starts_with("text/html");
    let cache = if is_html {
        "no-cache"
    } else {
        "public, max-age=300, must-revalidate"
    };
    Response::builder()
        .header(header::CONTENT_TYPE, asset.content_type)
        .header(header::CONTENT_ENCODING, enc)
        .header(header::VARY, "accept-encoding")
        .header(header::CACHE_CONTROL, cache)
        .header(header::ETAG, asset.etag)
        .body(Body::from(body))
        .unwrap()
}

fn raw_response(body: impl Into<Body>, content_type: &str, cache: &str) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .body(body.into())
        .unwrap()
}

async fn read_full_body(req: Request<Body>) -> Option<Vec<u8>> {
    let bytes = req.into_body().collect().await.ok()?.to_bytes();
    Some(bytes.to_vec())
}

async fn compute_tree(state: &AppState) -> JsonValue {
    {
        let g = state.tree_cache.read().await;
        if let Some((at, data)) = g.as_ref() {
            if at.elapsed() < TREE_CACHE_TTL {
                return data.clone();
            }
        }
    }
    let root = state.root.clone();
    let include_all = state.include_all;
    let walked =
        tokio::task::spawn_blocking(move || walk(&root, include_all, MAX_WALK_ENTRIES))
            .await
            .ok();
    let walked = walked.unwrap_or_else(|| crate::walker::WalkResult {
        paths: vec![],
        truncated: false,
        count: 0,
    });
    let (gs, branch, commit) = tokio::join!(
        git::git_status(&state.root),
        git::current_branch(&state.root),
        git::last_commit(&state.root)
    );
    let value = json!({
        "root": state.root_name,
        "absoluteRoot": state.root.to_string_lossy(),
        "displayRoot": state.display_root,
        "paths": walked.paths,
        "truncated": walked.truncated,
        "count": walked.count,
        "gitStatus": gs,
        "branch": branch,
        "commit": commit,
    });
    {
        let mut g = state.tree_cache.write().await;
        *g = Some((Instant::now(), value.clone()));
    }
    value
}

async fn compute_pulse(state: &AppState) -> JsonValue {
    let (branch, ahead_behind, gs, recent_commits) = tokio::join!(
        git::current_branch(&state.root),
        git::ahead_behind(&state.root),
        git::git_status(&state.root),
        git::recent_commits(&state.root, 5),
    );
    let dirty_count = gs
        .as_ref()
        .map(|entries| {
            entries
                .iter()
                .filter(|e| !matches!(e.status, git::GitStatus::Ignored))
                .count()
        })
        .unwrap_or(0);
    let recent_events = state.fs_ring.snapshot();
    json!({
        "branch": branch,
        "aheadBehind": ahead_behind,
        "dirtyCount": dirty_count,
        "recentCommits": recent_commits,
        "recentEvents": recent_events,
    })
}

async fn compute_history(state: &AppState) -> Vec<GitHistoryEntry> {
    {
        let g = state.history_cache.read().await;
        if let Some((at, data)) = g.as_ref() {
            if at.elapsed() < TREE_CACHE_TTL {
                return data.clone();
            }
        }
    }
    let gs = git::git_status(&state.root).await;
    let entries = state.history_store.list(gs.as_deref());
    {
        let mut g = state.history_cache.write().await;
        *g = Some((Instant::now(), entries.clone()));
    }
    entries
}

async fn proxy_http(
    method: Method,
    path: &str,
    uri: &http::Uri,
    peer_port: u16,
    token: &str,
    incoming_cookie: Option<&str>,
) -> Response {
    let _ = incoming_cookie;
    let peer = list_instances().into_iter().find(|i| i.port == peer_port);
    let Some(peer) = peer else {
        return (
            StatusCode::NOT_FOUND,
            json_response(&json!({ "error": "peer not found", "peerPort": peer_port })),
        )
            .into_response();
    };
    let pq = uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| path.to_string());
    let upstream_url = format!("http://{}:{}{}", peer.host, peer.port, pq);
    let url: hyper::Uri = match upstream_url.parse() {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                json_response(&json!({ "error": "bad upstream uri" })),
            )
                .into_response();
        }
    };
    let req_builder = hyper::Request::builder()
        .method(method)
        .uri(url.clone())
        .header(header::HOST, format!("{}:{}", peer.host, peer.port))
        .header(INTERNAL_HEADER, token);
    let outgoing = match req_builder.body(http_body_util::Empty::<hyper::body::Bytes>::new()) {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                json_response(&json!({ "error": "bad upstream request" })),
            )
                .into_response();
        }
    };
    use hyper_util::client::legacy::Client;
    use hyper_util::rt::TokioExecutor;
    let client: Client<_, http_body_util::Empty<hyper::body::Bytes>> =
        Client::builder(TokioExecutor::new()).build_http();
    match client.request(outgoing).await {
        Ok(resp) => {
            let (parts, body) = resp.into_parts();
            let bytes = match body.collect().await {
                Ok(b) => b.to_bytes(),
                Err(_) => {
                    return (
                        StatusCode::BAD_GATEWAY,
                        json_response(&json!({ "error": "peer body error" })),
                    )
                        .into_response();
                }
            };
            let mut builder = Response::builder().status(parts.status);
            for (k, v) in parts.headers.iter() {
                if k == header::TRANSFER_ENCODING {
                    continue;
                }
                builder = builder.header(k, v);
            }
            builder.body(Body::from(bytes.to_vec())).unwrap()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            json_response(&json!({
                "error": "peer unreachable",
                "peerPort": peer_port,
                "message": err.to_string(),
            })),
        )
            .into_response(),
    }
}

// ---------- Auth / passkey handlers ----------

fn build_session_cookie(sid: &str, ttl_secs: u64) -> String {
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        SESSION_COOKIE, sid, ttl_secs
    )
}

fn build_session_clear_cookie() -> String {
    format!("{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", SESSION_COOKIE)
}

fn json_status(status: StatusCode, value: serde_json::Value) -> Response {
    (status, json_response(&value)).into_response()
}

fn auto_device_name(headers: &HeaderMap) -> String {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let platform = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Device"
    };
    let browser = if ua.contains("CriOS") || ua.contains("Chrome") {
        " · Chrome"
    } else if ua.contains("Firefox") {
        " · Firefox"
    } else if ua.contains("Edg") {
        " · Edge"
    } else if ua.contains("Safari") {
        " · Safari"
    } else {
        ""
    };
    format!("{}{}", platform, browser)
}

#[derive(Deserialize)]
struct RegisterStartBody {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct RegisterFinishBody {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    credential: serde_json::Value,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct LoginFinishBody {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    credential: serde_json::Value,
}

async fn auth_register_start(
    State(state): State<SharedState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<RegisterStartBody>,
) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let internal = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok());
    let q = params.get("k").map(|s| s.as_str());
    if !state.can_register_device(q, cookie, internal) {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    let Some(svc) = state.passkey.get() else {
        return json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "passkey unavailable on this transport" }),
        );
    };
    let name = body
        .name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| auto_device_name(&headers));
    let user_uuid = uuid::Uuid::new_v4();
    let exclude = state.device_store.all_credential_ids();
    let exclude_creds = exclude
        .into_iter()
        .map(webauthn_rs::prelude::CredentialID::from)
        .collect::<Vec<_>>();
    match svc.start_registration(user_uuid, &name, &name, exclude_creds) {
        Ok((challenge_id, options)) => json_response(&json!({
            "challengeId": challenge_id,
            "options": options,
        })),
        Err(e) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("{}", e) }),
        ),
    }
}

async fn auth_register_finish(
    State(state): State<SharedState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinishBody>,
) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let internal = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok());
    let q = params.get("k").map(|s| s.as_str());
    if !state.can_register_device(q, cookie, internal) {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    let Some(svc) = state.passkey.get() else {
        return json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "passkey unavailable on this transport" }),
        );
    };
    let cred: webauthn_rs::prelude::RegisterPublicKeyCredential =
        match serde_json::from_value(body.credential) {
            Ok(c) => c,
            Err(e) => {
                return json_status(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": format!("bad credential: {}", e) }),
                );
            }
        };
    let (user_uuid, default_name, passkey) = match svc.finish_registration(&body.challenge_id, &cred) {
        Ok(t) => t,
        Err(e) => {
            return json_status(
                StatusCode::BAD_REQUEST,
                json!({ "error": format!("{}", e) }),
            );
        }
    };
    let name = body
        .name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_name);
    let cred_id = passkey.cred_id().as_ref().to_vec();
    let device_id = match state
        .device_store
        .add_device(user_uuid.as_bytes(), &cred_id, &name, &passkey)
    {
        Ok(id) => id,
        Err(e) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": format!("device store: {}", e) }),
            );
        }
    };
    let sid = match state
        .device_store
        .create_session(device_id, SESSION_TTL)
    {
        Ok(s) => s,
        Err(e) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": format!("session: {}", e) }),
            );
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::SET_COOKIE, build_session_cookie(&sid, SESSION_TTL.as_secs()))
        .body(Body::from(
            json!({ "deviceId": device_id, "name": name }).to_string(),
        ))
        .unwrap()
}

async fn auth_login_start(State(state): State<SharedState>) -> Response {
    let Some(svc) = state.passkey.get() else {
        return json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "passkey unavailable on this transport" }),
        );
    };
    let passkeys = state.device_store.all_passkeys();
    if passkeys.is_empty() {
        return json_status(
            StatusCode::PRECONDITION_FAILED,
            json!({ "error": "no devices registered yet" }),
        );
    }
    match svc.start_authentication(&passkeys) {
        Ok((challenge_id, options)) => json_response(&json!({
            "challengeId": challenge_id,
            "options": options,
        })),
        Err(e) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("{}", e) }),
        ),
    }
}

async fn auth_login_finish(
    State(state): State<SharedState>,
    Json(body): Json<LoginFinishBody>,
) -> Response {
    let Some(svc) = state.passkey.get() else {
        return json_status(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "passkey unavailable on this transport" }),
        );
    };
    let cred: webauthn_rs::prelude::PublicKeyCredential =
        match serde_json::from_value(body.credential) {
            Ok(c) => c,
            Err(e) => {
                return json_status(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": format!("bad credential: {}", e) }),
                );
            }
        };
    let result = match svc.finish_authentication(&body.challenge_id, &cred) {
        Ok(r) => r,
        Err(e) => {
            return json_status(
                StatusCode::UNAUTHORIZED,
                json!({ "error": format!("{}", e) }),
            );
        }
    };
    let cred_id = result.cred_id().as_ref().to_vec();
    let stored = match state.device_store.passkey_for_credential(&cred_id) {
        Some(s) => s,
        None => {
            return json_status(
                StatusCode::UNAUTHORIZED,
                json!({ "error": "credential not registered" }),
            );
        }
    };
    let mut updated = stored.passkey.clone();
    updated.update_credential(&result);
    let _ = state
        .device_store
        .update_passkey(stored.device_id, &updated);
    let sid = match state
        .device_store
        .create_session(stored.device_id, SESSION_TTL)
    {
        Ok(s) => s,
        Err(e) => {
            return json_status(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": format!("session: {}", e) }),
            );
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::SET_COOKIE, build_session_cookie(&sid, SESSION_TTL.as_secs()))
        .body(Body::from(
            json!({ "deviceId": stored.device_id }).to_string(),
        ))
        .unwrap()
}

async fn auth_logout(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    if let Some(sid) = crate::auth::read_cookie(cookie, SESSION_COOKIE) {
        state.device_store.revoke_session(&sid);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::SET_COOKIE, build_session_clear_cookie())
        .body(Body::from(json!({ "ok": true }).to_string()))
        .unwrap()
}

async fn auth_status(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let internal = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok());
    let authenticated = state.request_authenticated(cookie, internal);
    let passkey_available = state.passkey.get().is_some();
    let device_count = state.device_store.list_devices().len();
    let current_device_id = crate::auth::read_cookie(cookie, SESSION_COOKIE)
        .and_then(|sid| state.device_store.validate_session(&sid));
    json_response(&json!({
        "authenticated": authenticated,
        "authRequired": state.auth_required,
        "passkeyAvailable": passkey_available,
        "deviceCount": device_count,
        "currentDeviceId": current_device_id,
    }))
}

async fn list_devices(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let internal = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok());
    if !state.request_authenticated(cookie, internal) {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    let devices = state.device_store.list_devices();
    json_response(&json!({ "devices": devices }))
}

async fn delete_device(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    let internal = headers.get(INTERNAL_HEADER).and_then(|v| v.to_str().ok());
    if !state.request_authenticated(cookie, internal) {
        return json_status(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    match state.device_store.delete_device(id) {
        Ok(n) if n > 0 => json_response(&json!({ "ok": true })),
        Ok(_) => json_status(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
        Err(e) => json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("{}", e) }),
        ),
    }
}
