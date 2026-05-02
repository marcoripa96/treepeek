import type { Settings, UpdateSettings, ViewMode } from "../lib/settings";
import { pushSupported, subscribePush, unsubscribePush } from "../lib/push";
import { CloseCircle } from "./icons";
import { hapticLight, hapticSelection } from "../lib/haptics";

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
        </div>
      </aside>
    </>
  );
}
