import { useEffect, useState } from "react";
import {
  fetchAuthStatus,
  isWebAuthnAvailable,
  loginWithPasskey,
  registerPasskey,
} from "../lib/webauthn";

type Stage =
  | { kind: "checking" }
  | { kind: "logging-in" }
  | { kind: "pairing" }
  | { kind: "needs-qr" }
  | { kind: "passkey-failed" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface Props {
  children: React.ReactNode;
}

function readPairingToken(): string | null {
  const v = new URLSearchParams(location.search).get("k");
  return v && v.length > 0 ? v : null;
}

function clearPairingTokenFromUrl() {
  const u = new URL(location.href);
  if (!u.searchParams.has("k")) return;
  u.searchParams.delete("k");
  history.replaceState(null, "", u.toString());
}

export function AuthGate({ children }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await fetchAuthStatus();
      if (cancelled) return;
      if (!status) {
        setStage({ kind: "error", message: "Cannot reach the server." });
        return;
      }
      if (!status.authRequired || status.authenticated) {
        clearPairingTokenFromUrl();
        setStage({ kind: "ready" });
        return;
      }

      // Try passkey login first when this device already has a paired passkey.
      if (status.passkeyAvailable && status.deviceCount > 0 && isWebAuthnAvailable()) {
        setStage({ kind: "logging-in" });
        try {
          const ok = await loginWithPasskey();
          if (cancelled) return;
          if (ok) {
            clearPairingTokenFromUrl();
            setStage({ kind: "ready" });
            return;
          }
        } catch {
          // fall through to pairing or failure UI
        }
      }

      // No usable passkey on this device — fall back to pairing if we arrived
      // here with the master token in the URL.
      const pairingToken = readPairingToken();
      if (
        pairingToken &&
        status.passkeyAvailable &&
        isWebAuthnAvailable()
      ) {
        setStage({ kind: "pairing" });
        try {
          await registerPasskey({ pairingToken });
          if (cancelled) return;
          clearPairingTokenFromUrl();
          setStage({ kind: "ready" });
          return;
        } catch (e) {
          if (cancelled) return;
          setStage({
            kind: "error",
            message:
              e instanceof Error
                ? `Pairing failed: ${e.message}`
                : "Pairing failed.",
          });
          return;
        }
      }

      // Either no pairing token in URL or passkey unsupported on this transport.
      // If we have any chance of unlocking with a passkey, surface it; otherwise
      // ask the user to pair via QR.
      if (status.passkeyAvailable && status.deviceCount > 0 && isWebAuthnAvailable()) {
        setStage({ kind: "passkey-failed" });
      } else {
        setStage({ kind: "needs-qr" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (stage.kind === "ready") return <>{children}</>;

  if (stage.kind === "checking" || stage.kind === "logging-in" || stage.kind === "pairing") {
    const label =
      stage.kind === "logging-in"
        ? "Unlocking with passkey…"
        : stage.kind === "pairing"
          ? "Pairing this device…"
          : "Loading…";
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <div className="auth-gate-spinner" />
          <p>{label}</p>
        </div>
      </div>
    );
  }

  if (stage.kind === "passkey-failed") {
    const retry = async () => {
      setStage({ kind: "logging-in" });
      try {
        const ok = await loginWithPasskey();
        if (ok) setStage({ kind: "ready" });
        else setStage({ kind: "passkey-failed" });
      } catch {
        setStage({ kind: "passkey-failed" });
      }
    };
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <h1>Couldn't unlock</h1>
          <p>
            Your passkey for this device wasn't available. You can try again,
            or pair a fresh passkey by opening the share URL from the host.
          </p>
          <button
            type="button"
            className="auth-gate-link"
            onClick={() => void retry()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === "needs-qr") {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <h1>Pair this device</h1>
          <p>
            Open <code>treepeek</code> on the host and scan the QR code, or
            visit the share URL on this device to set up a passkey.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <h1>Something went wrong</h1>
        <p>{stage.message}</p>
        <button
          type="button"
          className="auth-gate-link"
          onClick={() => location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
