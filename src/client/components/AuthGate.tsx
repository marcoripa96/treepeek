import { useEffect, useState } from "react";
import {
  fetchAuthStatus,
  isWebAuthnAvailable,
  loginWithPasskey,
  type AuthStatus,
} from "../lib/webauthn";

type Stage =
  | { kind: "checking" }
  | { kind: "logging-in" }
  | { kind: "needs-pairing"; status: AuthStatus }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface Props {
  children: React.ReactNode;
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
        setStage({ kind: "ready" });
        return;
      }
      if (status.passkeyAvailable && status.deviceCount > 0 && isWebAuthnAvailable()) {
        setStage({ kind: "logging-in" });
        try {
          const ok = await loginWithPasskey();
          if (cancelled) return;
          if (ok) {
            setStage({ kind: "ready" });
            return;
          }
        } catch {
          // fall through
        }
      }
      setStage({ kind: "needs-pairing", status });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (stage.kind === "ready") return <>{children}</>;

  if (stage.kind === "checking" || stage.kind === "logging-in") {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <div className="auth-gate-spinner" />
          <p>{stage.kind === "logging-in" ? "Unlocking with passkey…" : "Loading…"}</p>
        </div>
      </div>
    );
  }

  if (stage.kind === "needs-pairing") {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <h1>Authentication required</h1>
          <p>
            Open <code>treepeek</code> on the host and scan the QR code, or
            visit the share URL once to pair this device with a passkey.
          </p>
          {stage.status.passkeyAvailable && stage.status.deviceCount > 0 ? (
            <button
              type="button"
              className="auth-gate-button"
              onClick={async () => {
                setStage({ kind: "logging-in" });
                try {
                  const ok = await loginWithPasskey();
                  if (ok) setStage({ kind: "ready" });
                  else
                    setStage({
                      kind: "needs-pairing",
                      status: stage.status,
                    });
                } catch (e) {
                  setStage({
                    kind: "error",
                    message: e instanceof Error ? e.message : "Unknown error",
                  });
                }
              }}
            >
              Try passkey again
            </button>
          ) : null}
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
          className="auth-gate-button"
          onClick={() => location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
