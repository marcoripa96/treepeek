use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use jwt_simple::algorithms::ECDSAP256PublicKeyLike;
use jwt_simple::prelude::ES256KeyPair;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, SubscriptionKeys, URL_SAFE_NO_PAD,
    VapidSignatureBuilder, WebPushClient, WebPushError, WebPushMessageBuilder,
};

const DEFAULT_VAPID_SUBJECT: &str = "mailto:treepeek@example.com";

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".config").join("treepeek")
}

fn vapid_file() -> PathBuf {
    config_dir().join("vapid.json")
}

fn subs_dir() -> PathBuf {
    config_dir().join("subs")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VapidConfig {
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "privateKey")]
    pub private_key: String,
    pub subject: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PushSubscriptionPayload {
    pub endpoint: String,
    #[serde(rename = "expirationTime", skip_serializing_if = "Option::is_none")]
    pub expiration_time: Option<serde_json::Value>,
    pub keys: SubscriptionKeysJson,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SubscriptionKeysJson {
    pub p256dh: String,
    pub auth: String,
}

fn is_acceptable_subject(s: &str) -> bool {
    if s.starts_with("https://") {
        return true;
    }
    if !s.starts_with("mailto:") {
        return false;
    }
    let local = &s[7..];
    let Some(at) = local.find('@') else {
        return false;
    };
    if at == 0 {
        return false;
    }
    let domain = &local[at + 1..];
    if !domain.contains('.') {
        return false;
    }
    if domain.ends_with(".local") {
        return false;
    }
    true
}

pub fn ensure_vapid() -> std::io::Result<VapidConfig> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(config_dir())?;
    let _ = std::fs::set_permissions(
        config_dir(),
        std::fs::Permissions::from_mode(0o700),
    );
    if let Ok(raw) = std::fs::read_to_string(vapid_file()) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            let pk = parsed.get("publicKey").and_then(|v| v.as_str());
            let sk = parsed.get("privateKey").and_then(|v| v.as_str());
            let sub = parsed.get("subject").and_then(|v| v.as_str());
            if let (Some(pk), Some(sk)) = (pk, sk) {
                let subject = sub
                    .filter(|s| is_acceptable_subject(s))
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| DEFAULT_VAPID_SUBJECT.to_string());
                let cfg = VapidConfig {
                    public_key: pk.to_string(),
                    private_key: sk.to_string(),
                    subject: subject.clone(),
                };
                if Some(subject.as_str()) != sub {
                    let _ = write_vapid(&cfg);
                }
                return Ok(cfg);
            }
        }
    }
    let kp = ES256KeyPair::generate();
    let priv_bytes = kp.to_bytes();
    let es_pub = kp.public_key();
    let pub_bytes = es_pub.public_key().to_bytes_uncompressed();
    let url = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let cfg = VapidConfig {
        public_key: url.encode(&pub_bytes),
        private_key: url.encode(&priv_bytes),
        subject: DEFAULT_VAPID_SUBJECT.to_string(),
    };
    write_vapid(&cfg)?;
    Ok(cfg)
}

fn write_vapid(cfg: &VapidConfig) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(vapid_file())?;
    use std::io::Write;
    let s = serde_json::to_string_pretty(cfg)?;
    f.write_all(s.as_bytes())?;
    Ok(())
}

fn subs_file(root_path: &str) -> PathBuf {
    let url = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let enc = url.encode(root_path);
    subs_dir().join(format!("{}.json", enc))
}

fn read_subs(root_path: &str) -> Vec<PushSubscriptionPayload> {
    let raw = match std::fs::read_to_string(subs_file(root_path)) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_subs(root_path: &str, subs: &[PushSubscriptionPayload]) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::create_dir_all(subs_dir())?;
    let _ = std::fs::set_permissions(
        subs_dir(),
        std::fs::Permissions::from_mode(0o700),
    );
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(subs_file(root_path))?;
    use std::io::Write;
    f.write_all(serde_json::to_string_pretty(subs)?.as_bytes())?;
    Ok(())
}

#[derive(Serialize)]
pub struct DispatchPayload<'a> {
    pub title: &'a str,
    pub body: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<&'a str>,
}

pub struct PushManager {
    root_path: String,
    inner: Arc<Mutex<Inner>>,
    vapid: Arc<Mutex<Option<VapidConfig>>>,
    client: IsahcWebPushClient,
    throttle: Duration,
}

struct Inner {
    subs: Vec<PushSubscriptionPayload>,
    last_sent: Option<Instant>,
    loaded: bool,
}

impl PushManager {
    pub fn new(root_path: String) -> Result<Self, WebPushError> {
        Ok(Self {
            root_path,
            inner: Arc::new(Mutex::new(Inner {
                subs: Vec::new(),
                last_sent: None,
                loaded: false,
            })),
            vapid: Arc::new(Mutex::new(None)),
            client: IsahcWebPushClient::new()?,
            throttle: Duration::from_millis(5_000),
        })
    }

    pub async fn set_vapid(&self, cfg: VapidConfig) {
        *self.vapid.lock().await = Some(cfg);
    }

    pub async fn load(&self) {
        let mut g = self.inner.lock().await;
        if g.loaded {
            return;
        }
        g.subs = read_subs(&self.root_path);
        g.loaded = true;
    }

    pub async fn has_subscriptions(&self) -> bool {
        !self.inner.lock().await.subs.is_empty()
    }

    pub async fn add_subscription(&self, sub: PushSubscriptionPayload) {
        self.load().await;
        let mut g = self.inner.lock().await;
        if g.subs.iter().any(|s| s.endpoint == sub.endpoint) {
            return;
        }
        g.subs.push(sub);
        let _ = write_subs(&self.root_path, &g.subs);
    }

    pub async fn remove_subscription(&self, endpoint: &str) {
        self.load().await;
        let mut g = self.inner.lock().await;
        let before = g.subs.len();
        g.subs.retain(|s| s.endpoint != endpoint);
        if g.subs.len() != before {
            let _ = write_subs(&self.root_path, &g.subs);
        }
    }

    pub async fn dispatch(&self, payload: &DispatchPayload<'_>) {
        self.load().await;
        let vapid = match self.vapid.lock().await.clone() {
            Some(v) => v,
            None => return,
        };
        let now = Instant::now();
        let subs_snapshot = {
            let mut g = self.inner.lock().await;
            if g.subs.is_empty() {
                return;
            }
            if let Some(last) = g.last_sent {
                if now.duration_since(last) < self.throttle {
                    return;
                }
            }
            g.last_sent = Some(now);
            g.subs.clone()
        };
        let json = match serde_json::to_string(payload) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut stale: Vec<String> = Vec::new();
        for sub in &subs_snapshot {
            let info = SubscriptionInfo {
                endpoint: sub.endpoint.clone(),
                keys: SubscriptionKeys {
                    p256dh: sub.keys.p256dh.clone(),
                    auth: sub.keys.auth.clone(),
                },
            };
            let mut sig_builder = match VapidSignatureBuilder::from_base64(
                &vapid.private_key,
                URL_SAFE_NO_PAD,
                &info,
            ) {
                Ok(b) => b,
                Err(_) => continue,
            };
            sig_builder.add_claim("sub", vapid.subject.as_str());
            let sig = match sig_builder.build() {
                Ok(s) => s,
                Err(_) => continue,
            };
            let mut builder = WebPushMessageBuilder::new(&info);
            builder.set_payload(ContentEncoding::Aes128Gcm, json.as_bytes());
            builder.set_vapid_signature(sig);
            let msg = match builder.build() {
                Ok(m) => m,
                Err(_) => continue,
            };
            match self.client.send(msg).await {
                Ok(_) => {}
                Err(err) => {
                    if matches!(
                        err,
                        WebPushError::EndpointNotFound | WebPushError::EndpointNotValid
                    ) {
                        stale.push(sub.endpoint.clone());
                    } else {
                        let host = url_host(&sub.endpoint).unwrap_or_else(|| "?".into());
                        eprintln!(
                            "[treepeek] push send failed {}: {:?}",
                            host, err
                        );
                    }
                }
            }
        }
        if !stale.is_empty() {
            let mut g = self.inner.lock().await;
            g.subs.retain(|s| !stale.contains(&s.endpoint));
            let _ = write_subs(&self.root_path, &g.subs);
        }
    }
}

fn url_host(s: &str) -> Option<String> {
    let after_scheme = s.split("://").nth(1)?;
    let host = after_scheme.split('/').next()?;
    Some(host.to_string())
}

pub fn is_valid_subscription(value: &serde_json::Value) -> bool {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false,
    };
    let endpoint = match obj.get("endpoint").and_then(|v| v.as_str()) {
        Some(e) => e,
        None => return false,
    };
    if !endpoint.starts_with("https://") {
        return false;
    }
    let keys = match obj.get("keys").and_then(|v| v.as_object()) {
        Some(k) => k,
        None => return false,
    };
    keys.get("p256dh").and_then(|v| v.as_str()).is_some()
        && keys.get("auth").and_then(|v| v.as_str()).is_some()
}
