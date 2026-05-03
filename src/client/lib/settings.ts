import { useCallback, useState } from "react";

export type ViewMode = "pulse" | "list" | "folders" | "history";
export type TreeViewMode = Exclude<ViewMode, "pulse">;

export interface Settings {
  notifications: boolean;
  defaultView: ViewMode;
  lastTreeView: TreeViewMode;
}

const SETTINGS_KEY = "tp-settings";
const LEGACY_VIEW_KEY = "tp-view-mode";

const DEFAULT_SETTINGS: Settings = {
  notifications: false,
  defaultView: "pulse",
  lastTreeView: "list",
};

function coerceTreeView(v: unknown): TreeViewMode {
  return v === "history" || v === "folders" ? v : "list";
}

function coerceView(v: unknown): ViewMode {
  if (v === "pulse" || v === "history" || v === "folders" || v === "list") return v;
  return "pulse";
}

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const merged: Settings = {
        notifications:
          typeof parsed.notifications === "boolean"
            ? parsed.notifications
            : DEFAULT_SETTINGS.notifications,
        defaultView: coerceView(parsed.defaultView),
        lastTreeView: coerceTreeView(parsed.lastTreeView ?? parsed.defaultView),
      };
      return reconcileNotificationPermission(merged);
    }
    const legacy = localStorage.getItem(LEGACY_VIEW_KEY);
    if (legacy === "history" || legacy === "folders" || legacy === "list") {
      return { ...DEFAULT_SETTINGS, lastTreeView: legacy };
    }
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
