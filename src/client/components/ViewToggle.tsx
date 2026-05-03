import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Folder, History, List } from "./icons";
import { hapticSelection } from "../lib/haptics";
import type { ViewMode } from "../lib/settings";

interface Props {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  onExitPulse: () => void;
  hidden: boolean;
}

const TREE_MODES: { mode: Exclude<ViewMode, "pulse">; label: string; icon: ReactNode }[] = [
  { mode: "folders", label: "Folders", icon: <Folder width={20} height={20} /> },
  { mode: "list", label: "List", icon: <List width={20} height={20} /> },
  { mode: "history", label: "History", icon: <History width={20} height={20} /> },
];

const PILL_SPRING = { type: "spring" as const, stiffness: 520, damping: 42, mass: 0.8 };
const LAYOUT_TWEEN = { type: "tween" as const, duration: 0.18, ease: [0.32, 0.72, 0, 1] as [number, number, number, number] };
const FADE = { duration: 0.15 };

export function ViewToggle({ mode, onChange, onExitPulse, hidden }: Props) {
  const select = (next: ViewMode) => {
    if (mode !== next) hapticSelection();
    onChange(next);
  };

  return (
    <div className={"view-toggle-slot" + (hidden ? " hidden" : "")}>
      <AnimatePresence initial={false} mode="wait">
        {mode === "pulse" ? (
          <motion.button
            key="back-to-tree"
            type="button"
            className="view-toggle-back"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={FADE}
            onClick={() => {
              hapticSelection();
              onExitPulse();
            }}
            aria-label="back to tree"
          >
            <span className="view-toggle-back-icon">
              <ChevronRight width={18} height={18} />
            </span>
            <span className="view-toggle-back-label">Tree</span>
          </motion.button>
        ) : (
          <motion.div
            key="tree-toggle"
            layout
            transition={LAYOUT_TWEEN}
            className="view-toggle"
            role="group"
            aria-label="view mode"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
          >
            {TREE_MODES.map(({ mode: m, label, icon }) => {
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
        )}
      </AnimatePresence>
    </div>
  );
}
