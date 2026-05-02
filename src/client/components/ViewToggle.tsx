import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Folder, History, List } from "./icons";
import { hapticSelection } from "../lib/haptics";

export type ViewMode = "list" | "folders" | "history";

interface Props {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  hidden: boolean;
}

const MODES: { mode: ViewMode; label: string; icon: ReactNode }[] = [
  { mode: "folders", label: "Folders", icon: <Folder width={20} height={20} /> },
  { mode: "list", label: "List", icon: <List width={20} height={20} /> },
  { mode: "history", label: "History", icon: <History width={20} height={20} /> },
];

const PILL_SPRING = { type: "spring" as const, stiffness: 520, damping: 42, mass: 0.8 };
const LAYOUT_TWEEN = { type: "tween" as const, duration: 0.18, ease: [0.32, 0.72, 0, 1] as [number, number, number, number] };

export function ViewToggle({ mode, onChange, hidden }: Props) {
  const select = (next: ViewMode) => {
    if (mode !== next) hapticSelection();
    onChange(next);
  };
  return (
    <motion.div
      layout
      transition={LAYOUT_TWEEN}
      className={"view-toggle" + (hidden ? " hidden" : "")}
      role="group"
      aria-label="view mode"
    >
      {MODES.map(({ mode: m, label, icon }) => {
        const active = mode === m;
        return (
          <motion.button
            layout
            transition={LAYOUT_TWEEN}
            key={m}
            className="view-mode-btn"
            type="button"
            data-mode={m}
            aria-label={`${label.toLowerCase()} view`}
            aria-selected={active}
            onClick={() => select(m)}
          >
            {active && (
              <motion.span
                layoutId="view-toggle-active"
                className="view-mode-pill"
                transition={PILL_SPRING}
              />
            )}
            <motion.span layout className="view-mode-content" transition={LAYOUT_TWEEN}>
              {icon}
              {active && <span className="view-mode-label">{label}</span>}
            </motion.span>
          </motion.button>
        );
      })}
    </motion.div>
  );
}
