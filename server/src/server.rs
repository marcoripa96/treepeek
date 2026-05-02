use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::assets::{
    EmbeddedAsset, CLIENT_ASSETS, ICON_PNG_192, ICON_PNG_512, ICON_SVG, SERVICE_WORKER_JS,
};
use crate::auth::{build_cookie_header, is_authenticated};
use crate::diff::get_file_diff;
use crate::file::read_file_safe;
use crate::git::{self, GitHistoryEntry};
use crate::history::HistoryStore;
use crate::outline;
use crate::push::{is_valid_subscription, PushManager, PushSubscriptionPayload};
use crate::registry::list_instances;
use crate::search::SearchService;
use crate::walker::walk;

const TREE_CACHE_TTL: Duration = Duration::from_millis(5_000);
const MAX_WALK_ENTRIES: usize = 50_000;

type SharedState = Arc<AppState>;

pub struct AppState {
    pub root: PathBuf,
    pub root_name: String,
    pub display_root: String,
    pub include_all: bool,
    pub token: String,
    pub manifest_json: String,
    pub history_store: Arc<HistoryStore>,
    pub push_manager: Arc<PushManager>,
    pub vapid_public_key: Option<String>,
    pub search: Option<Arc<SearchService>>,
    pub server_port: tokio::sync::OnceCell<u16>,
    pub sockets: Mutex<Vec<mpsc::UnboundedSender<String>>>,
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
        manifest_json: String,
        history_store: Arc<HistoryStore>,
        push_manager: Arc<PushManager>,
        vapid_public_key: Option<String>,
        search: Option<Arc<SearchService>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            root,
            root_name,
            display_root,
            include_all,
            token,
            manifest_json,
            history_store,
            push_manager,
            vapid_public_key,
            search,
            server_port: tokio::sync::OnceCell::new(),
            sockets: Mutex::new(Vec::new()),
            tree_cache: RwLock::new(None),
            history_cache: RwLock::new(None),
        })
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
    let q = params.get("k").map(|s| s.as_str());
    if !is_authenticated(q, cookie, &state.token) {
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
    req.headers_mut().insert(
        "cookie",
        format!("tp_session={}", token).parse().unwrap(),
    );
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

    let q_k = query.get("k").map(|s| s.as_str());
    if !is_authenticated(q_k, cookie_header.as_deref(), &state.token) {
        return unauthorized(&req);
    }

    if path == "/" && query.get("k").is_some() {
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, "/")
            .header(header::SET_COOKIE, build_cookie_header(&state.token))
            .body(Body::empty())
            .unwrap();
    }

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
                || path == "/api/outline")
        {
            return proxy_http(method, &path, &uri, pp, &state.token, cookie_header.as_deref())
                .await;
        }
    }

    if path == "/api/tree" {
        let data = compute_tree(&state).await;
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
        .header(header::COOKIE, format!("tp_session={}", token));
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

