function b64urlToBuf(s: string): ArrayBuffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufToB64url(buf: ArrayBuffer | Uint8Array | null): string | null {
  if (!buf) return null;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface CredentialDescriptorJSON {
  id: string;
  type: string;
  transports?: string[];
}

function decodeCredentialList(
  list: CredentialDescriptorJSON[] | undefined
): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.map((c) => ({
    id: b64urlToBuf(c.id),
    type: c.type as PublicKeyCredentialType,
    transports: c.transports as AuthenticatorTransport[] | undefined,
  }));
}

interface ServerCreationOptions {
  publicKey: {
    challenge: string;
    rp: { id?: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: Array<{ alg: number; type: string }>;
    timeout?: number;
    excludeCredentials?: CredentialDescriptorJSON[];
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    attestation?: AttestationConveyancePreference;
    extensions?: Record<string, unknown>;
  };
}

interface ServerRequestOptions {
  publicKey: {
    challenge: string;
    timeout?: number;
    rpId?: string;
    allowCredentials?: CredentialDescriptorJSON[];
    userVerification?: UserVerificationRequirement;
    extensions?: Record<string, unknown>;
  };
}

function decodeCreationOptions(
  opts: ServerCreationOptions
): CredentialCreationOptions {
  const pk = opts.publicKey;
  return {
    publicKey: {
      challenge: b64urlToBuf(pk.challenge),
      rp: pk.rp,
      user: {
        id: b64urlToBuf(pk.user.id),
        name: pk.user.name,
        displayName: pk.user.displayName,
      },
      pubKeyCredParams: pk.pubKeyCredParams.map((p) => ({
        alg: p.alg,
        type: p.type as PublicKeyCredentialType,
      })),
      ...(pk.timeout != null ? { timeout: pk.timeout } : {}),
      ...(pk.excludeCredentials
        ? { excludeCredentials: decodeCredentialList(pk.excludeCredentials) }
        : {}),
      ...(pk.authenticatorSelection
        ? { authenticatorSelection: pk.authenticatorSelection }
        : {}),
      ...(pk.attestation ? { attestation: pk.attestation } : {}),
    } as PublicKeyCredentialCreationOptions,
  };
}

function decodeRequestOptions(
  opts: ServerRequestOptions
): CredentialRequestOptions {
  const pk = opts.publicKey;
  return {
    publicKey: {
      challenge: b64urlToBuf(pk.challenge),
      ...(pk.timeout != null ? { timeout: pk.timeout } : {}),
      ...(pk.rpId ? { rpId: pk.rpId } : {}),
      ...(pk.allowCredentials
        ? { allowCredentials: decodeCredentialList(pk.allowCredentials) }
        : {}),
      ...(pk.userVerification ? { userVerification: pk.userVerification } : {}),
    } as PublicKeyCredentialRequestOptions,
  };
}

function encodeRegistrationCredential(cred: PublicKeyCredential) {
  const att = cred.response as AuthenticatorAttestationResponse;
  const transports =
    typeof att.getTransports === "function" ? att.getTransports() : undefined;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: bufToB64url(att.attestationObject),
      clientDataJSON: bufToB64url(att.clientDataJSON),
      ...(transports && transports.length ? { transports } : {}),
    },
    extensions: cred.getClientExtensionResults(),
  };
}

function encodeAuthenticationCredential(cred: PublicKeyCredential) {
  const ass = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      authenticatorData: bufToB64url(ass.authenticatorData),
      clientDataJSON: bufToB64url(ass.clientDataJSON),
      signature: bufToB64url(ass.signature),
      userHandle: ass.userHandle ? bufToB64url(ass.userHandle) : null,
    },
    extensions: cred.getClientExtensionResults(),
  };
}

export function isWebAuthnAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === "function"
  );
}

export interface AuthStatus {
  authenticated: boolean;
  authRequired: boolean;
  passkeyAvailable: boolean;
  deviceCount: number;
  currentDeviceId: number | null;
}

export async function fetchAuthStatus(): Promise<AuthStatus | null> {
  try {
    const r = await fetch("/api/auth/status", { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as AuthStatus;
  } catch {
    return null;
  }
}

export interface DeviceRow {
  id: number;
  name: string;
  created_at: string;
  last_seen_at: string;
}

export async function listDevices(): Promise<DeviceRow[]> {
  const r = await fetch("/api/devices", { cache: "no-store" });
  if (!r.ok) return [];
  const j = (await r.json()) as { devices: DeviceRow[] };
  return j.devices ?? [];
}

export async function deleteDevice(id: number): Promise<boolean> {
  const r = await fetch(`/api/devices/${id}`, { method: "DELETE" });
  return r.ok;
}

export interface RegisterOptions {
  name?: string;
  /** Master token from the QR `?k=` param. Required for first-device pairing. */
  pairingToken?: string;
}

export async function registerPasskey(
  options?: RegisterOptions
): Promise<{ deviceId: number; name: string }> {
  if (!isWebAuthnAvailable()) throw new Error("WebAuthn not available");
  const { name, pairingToken } = options ?? {};
  const qs = pairingToken ? `?k=${encodeURIComponent(pairingToken)}` : "";
  const startRes = await fetch(`/api/auth/register/start${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name ?? null }),
  });
  if (!startRes.ok) {
    const err = await safeJson(startRes);
    throw new Error(err?.error ?? `register/start ${startRes.status}`);
  }
  const startJson = (await startRes.json()) as {
    challengeId: string;
    options: ServerCreationOptions;
  };
  const opts = decodeCreationOptions(startJson.options);
  const cred = (await navigator.credentials.create(opts)) as PublicKeyCredential | null;
  if (!cred) throw new Error("registration cancelled");
  const finishRes = await fetch(`/api/auth/register/finish${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: startJson.challengeId,
      credential: encodeRegistrationCredential(cred),
      ...(name ? { name } : {}),
    }),
  });
  if (!finishRes.ok) {
    const err = await safeJson(finishRes);
    throw new Error(err?.error ?? `register/finish ${finishRes.status}`);
  }
  return (await finishRes.json()) as { deviceId: number; name: string };
}

export async function loginWithPasskey(): Promise<{ deviceId: number } | null> {
  if (!isWebAuthnAvailable()) return null;
  const startRes = await fetch("/api/auth/login/start", { method: "POST" });
  if (startRes.status === 412) return null; // no devices registered
  if (!startRes.ok) return null;
  const startJson = (await startRes.json()) as {
    challengeId: string;
    options: ServerRequestOptions;
  };
  const opts = decodeRequestOptions(startJson.options);
  const cred = (await navigator.credentials.get(opts)) as PublicKeyCredential | null;
  if (!cred) return null;
  const finishRes = await fetch("/api/auth/login/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: startJson.challengeId,
      credential: encodeAuthenticationCredential(cred),
    }),
  });
  if (!finishRes.ok) return null;
  return (await finishRes.json()) as { deviceId: number };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
