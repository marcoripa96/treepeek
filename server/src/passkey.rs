use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use rand::RngCore;
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::*;
use webauthn_rs::Webauthn;

const PENDING_TTL: Duration = Duration::from_secs(300);

pub struct PasskeyService {
    webauthn: Webauthn,
    pending_reg: Mutex<HashMap<String, PendingReg>>,
    pending_auth: Mutex<HashMap<String, PendingAuth>>,
}

struct PendingReg {
    state: PasskeyRegistration,
    user_uuid: Uuid,
    name: String,
    expires_at: Instant,
}

struct PendingAuth {
    state: PasskeyAuthentication,
    expires_at: Instant,
}

impl PasskeyService {
    pub fn new(rp_id: &str, rp_origin: &Url) -> Result<Self, WebauthnError> {
        let webauthn = WebauthnBuilder::new(rp_id, rp_origin)?
            .rp_name("treepeek")
            .build()?;
        Ok(Self {
            webauthn,
            pending_reg: Mutex::new(HashMap::new()),
            pending_auth: Mutex::new(HashMap::new()),
        })
    }

    pub fn start_registration(
        &self,
        user_uuid: Uuid,
        user_display_name: &str,
        device_name: &str,
        exclude_credentials: Vec<CredentialID>,
    ) -> Result<(String, CreationChallengeResponse), WebauthnError> {
        let exclude = if exclude_credentials.is_empty() {
            None
        } else {
            Some(exclude_credentials)
        };
        let (challenge, state) = self.webauthn.start_passkey_registration(
            user_uuid,
            user_display_name,
            user_display_name,
            exclude,
        )?;
        let challenge_id = random_id();
        self.gc_pending_reg();
        self.pending_reg.lock().unwrap().insert(
            challenge_id.clone(),
            PendingReg {
                state,
                user_uuid,
                name: device_name.to_string(),
                expires_at: Instant::now() + PENDING_TTL,
            },
        );
        Ok((challenge_id, challenge))
    }

    pub fn finish_registration(
        &self,
        challenge_id: &str,
        reg: &RegisterPublicKeyCredential,
    ) -> Result<(Uuid, String, Passkey), PasskeyError> {
        let pending = self
            .pending_reg
            .lock()
            .unwrap()
            .remove(challenge_id)
            .ok_or(PasskeyError::UnknownChallenge)?;
        if Instant::now() > pending.expires_at {
            return Err(PasskeyError::Expired);
        }
        let passkey = self
            .webauthn
            .finish_passkey_registration(reg, &pending.state)
            .map_err(PasskeyError::Webauthn)?;
        Ok((pending.user_uuid, pending.name, passkey))
    }

    pub fn start_authentication(
        &self,
        passkeys: &[Passkey],
    ) -> Result<(String, RequestChallengeResponse), WebauthnError> {
        let (challenge, state) = self.webauthn.start_passkey_authentication(passkeys)?;
        let challenge_id = random_id();
        self.gc_pending_auth();
        self.pending_auth.lock().unwrap().insert(
            challenge_id.clone(),
            PendingAuth {
                state,
                expires_at: Instant::now() + PENDING_TTL,
            },
        );
        Ok((challenge_id, challenge))
    }

    pub fn finish_authentication(
        &self,
        challenge_id: &str,
        cred: &PublicKeyCredential,
    ) -> Result<AuthenticationResult, PasskeyError> {
        let pending = self
            .pending_auth
            .lock()
            .unwrap()
            .remove(challenge_id)
            .ok_or(PasskeyError::UnknownChallenge)?;
        if Instant::now() > pending.expires_at {
            return Err(PasskeyError::Expired);
        }
        self.webauthn
            .finish_passkey_authentication(cred, &pending.state)
            .map_err(PasskeyError::Webauthn)
    }

    fn gc_pending_reg(&self) {
        let now = Instant::now();
        self.pending_reg
            .lock()
            .unwrap()
            .retain(|_, v| v.expires_at > now);
    }

    fn gc_pending_auth(&self) {
        let now = Instant::now();
        self.pending_auth
            .lock()
            .unwrap()
            .retain(|_, v| v.expires_at > now);
    }
}

#[derive(Debug)]
pub enum PasskeyError {
    UnknownChallenge,
    Expired,
    Webauthn(WebauthnError),
}

impl std::fmt::Display for PasskeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PasskeyError::UnknownChallenge => write!(f, "unknown or expired challenge"),
            PasskeyError::Expired => write!(f, "challenge expired"),
            PasskeyError::Webauthn(e) => write!(f, "webauthn: {}", e),
        }
    }
}

fn random_id() -> String {
    let mut bytes = [0u8; 18];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
