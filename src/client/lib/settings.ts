import { useCallback, useState } from "react";

export type ViewMode = "list" | "folders" | "history";

export interface Settings {
  notifications: boolean;
  defaultView: ViewMode;
}

const SETTINGS_KEY = "tp-settings";
const LEGACY_VIEW_KEY = "tp-view-mode";

const DEFAULT_SETTINGS: Settings = {
  notifications: false,
  defaultView: "list",
};

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const merged: Settings = {
        notifications: typeof parsed.notifications === "boolean" ? parsed.notifications : DEFAULT_SETTINGS.notifications,
        defaultView:
          parsed.defaultView === "history"
            ? "history"
            : parsed.defaultView === "folders"
              ? "folders"
              : "list",
      };
      return reconcileNotificationPermission(merged);
    }
    const legacy = localStorage.getItem(LEGACY_VIEW_KEY);
    if (legacy === "history") return { ...DEFAULT_SETTINGS, defaultView: "history" };
    if (legacy === "folders") return { ...DEFAULT_SETTINGS, defaultView: "folders" };
    return DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function reconcileNotificationPermission(s: Settings): Settings {
  if (!s.notifications) return s;
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ...s, notifications: false };
  }
  if (Notification.permission !== "granted") {
    return { ...s, notifications: false };
  }
  return s;
}

function writeSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

export type UpdateSettings = (patch: Partial<Settings>) => void;

export function useSettings(): [Settings, UpdateSettings] {
  const [settings, setSettings] = useState<Settings>(readSettings);
  const update = useCallback<UpdateSettings>((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);
  return [settings, update];
}
