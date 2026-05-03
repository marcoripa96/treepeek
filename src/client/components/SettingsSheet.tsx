import { useEffect, useState } from "react";
import type { Settings, UpdateSettings, ViewMode } from "../lib/settings";
import { pushSupported, subscribePush, unsubscribePush } from "../lib/push";
import { CloseCircle } from "./icons";
import { hapticLight, hapticSelection, hapticSuccess, hapticError } from "../lib/haptics";
import {
  deleteDevice,
  fetchAuthStatus,
  isWebAuthnAvailable,
  listDevices,
  logout,
  registerPasskey,
  type AuthStatus,
  type DeviceRow,
} from "../lib/webauthn";

interface Props {
  open: boolean;
  settings: Settings;
  onUpdate: UpdateSettings;
  onClose: () => void;
}

export function SettingsSheet({
  open,
  settings,
  onUpdate,
  onClose,
}: Props) {
  const handleNotificationsChange = async (enabled: boolean) => {
    hapticSelection();
    if (!enabled) {
      await unsubscribePush();
      onUpdate({ notifications: false });
      return;
    }
    if (!pushSupported()) return;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result !== "granted") return;
    }
    const ok = await subscribePush();
    onUpdate({ notifications: ok });
  };

  const setDefaultView = (view: ViewMode) => {
    hapticSelection();
    onUpdate({ defaultView: view });
  };

  const handleClose = () => {
    hapticLight();
    onClose();
  };

  const notificationsUnsupported = !pushSupported();
  const notificationsBlocked =
    !notificationsUnsupported &&
    typeof window !== "undefined" &&
    "Notification" in window &&
    Notification.permission === "denied";

  return (
    <>
      <div
        id="settings-backdrop"
        className={open ? "open" : undefined}
        onClick={handleClose}
      />
      <aside
        id="settings-sheet"
        className={open ? "open" : undefined}
        aria-hidden={!open}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-handle" aria-hidden="true" />
        <header className="settings-header">
          <h2>Settings</h2>
          <button
            className="settings-close"
            type="button"
            aria-label="Close settings"
            onClick={handleClose}
          >
            <CloseCircle width={22} height={22} />
          </button>
        </header>
        <div className="settings-body">
          <label className="settings-row">
            <span className="settings-label">
              Enable notifications
              {notificationsUnsupported && (
                <span className="settings-hint">Not supported in this browser</span>
              )}
              {notificationsBlocked && (
                <span className="settings-hint">Blocked — allow in browser settings</span>
              )}
            </span>
            <input
              type="checkbox"
              className="toggle-switch"
              checked={settings.notifications}
              disabled={notificationsUnsupported || notificationsBlocked}
              onChange={(e) => void handleNotificationsChange(e.target.checked)}
            />
          </label>

          <div className="settings-row">
            <span className="settings-label">Default view</span>
            <div className="settings-segmented" role="radiogroup" aria-label="default view">
              <button
                type="button"
                className="settings-segment"
                role="radio"
                aria-checked={settings.defaultView === "folders"}
                onClick={() => setDefaultView("folders")}
              >
                Folders
              </button>
              <button
                type="button"
                className="settings-segment"
                role="radio"
                aria-checked={settings.defaultView === "list"}
                onClick={() => setDefaultView("list")}
              >
                List
              </button>
              <button
                type="button"
                className="settings-segment"
                role="radio"
                aria-checked={settings.defaultView === "history"}
                onClick={() => setDefaultView("history")}
              >
                History
              </button>
            </div>
          </div>

          <DevicesSection open={open} />
        </div>
      </aside>
    </>
  );
}

function DevicesSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const [s, d] = await Promise.all([fetchAuthStatus(), listDevices()]);
    setStatus(s);
    setDevices(d);
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  if (!status) return null;
  if (!status.authRequired) {
    return (
      <div className="settings-row settings-row-block">
        <span className="settings-label">Devices</span>
        <p className="settings-hint">
          Trusting the tailnet — no per-device auth on this transport.
        </p>
      </div>
    );
  }
  if (!status.passkeyAvailable) {
    return (
      <div className="settings-row settings-row-block">
        <span className="settings-label">Devices</span>
        <p className="settings-hint">
          Passkeys require a public HTTPS origin (Funnel or Tunnel mode).
        </p>
      </div>
    );
  }

  const onAddPasskey = async () => {
    if (!isWebAuthnAvailable()) {
      setMessage("WebAuthn not available in this browser.");
      hapticError();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await registerPasskey();
      hapticSuccess();
      setMessage(`Paired as “${r.name}”.`);
      await refresh();
    } catch (e) {
      hapticError();
      setMessage(e instanceof Error ? e.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (id: number, name: string) => {
    if (!confirm(`Revoke “${name}”? This signs the device out.`)) return;
    setBusy(true);
    const ok = await deleteDevice(id);
    if (ok) hapticSelection();
    else hapticError();
    await refresh();
    setBusy(false);
  };

  const onLogout = async () => {
    setBusy(true);
    await logout();
    hapticSelection();
    location.reload();
  };

  return (
    <div className="settings-row settings-row-block">
      <span className="settings-label">Devices</span>
      <div className="device-list">
        {devices.length === 0 ? (
          <p className="settings-hint">No devices paired yet.</p>
        ) : (
          devices.map((d) => (
            <div key={d.id} className="device-row">
              <div className="device-meta">
                <div className="device-name">{d.name}</div>
                <div className="device-time">
                  Last seen {formatRelative(d.last_seen_at)}
                </div>
              </div>
              <button
                type="button"
                className="device-revoke"
                disabled={busy}
                onClick={() => void onRevoke(d.id, d.name)}
              >
                Revoke
              </button>
            </div>
          ))
        )}
      </div>
      <div className="device-actions">
        <button
          type="button"
          className="device-action-primary"
          disabled={busy}
          onClick={() => void onAddPasskey()}
        >
          Add passkey for this device
        </button>
        <button
          type="button"
          className="device-action-secondary"
          disabled={busy}
          onClick={() => void onLogout()}
        >
          Sign out this device
        </button>
      </div>
      {message ? <p className="settings-hint">{message}</p> : null}
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(t).toLocaleDateString();
}
