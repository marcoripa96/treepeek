import { useEffect, useLayoutEffect, useRef } from "react";
import { CloseCircle, Magnifer } from "./icons";
import { hapticSelection } from "../lib/haptics";

interface Props {
  open: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  onOpen: () => void;
  onClose: () => void;
}

export function SearchBar({ open, query, onQueryChange, onOpen, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const focusInput = () => {
    inputRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (open) focusInput();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(focusInput);
    const timer = setTimeout(focusInput, 80);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!window.visualViewport) {
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
      return;
    }

    const viewport = window.visualViewport;
    let frame: number | null = null;
    const updateKeyboardInset = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
      });
    };

    updateKeyboardInset();
    viewport.addEventListener("resize", updateKeyboardInset);
    viewport.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);
    window.addEventListener("scroll", updateKeyboardInset, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", updateKeyboardInset);
      viewport.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
      window.removeEventListener("scroll", updateKeyboardInset);
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
    };
  }, []);

  return (
    <>
      <button
        className={"search-toggle" + (open ? " hidden" : "")}
        type="button"
        aria-label="open search"
        onClick={() => {
          hapticSelection();
          onOpen();
          requestAnimationFrame(focusInput);
        }}
      >
        <Magnifer width={22} height={22} />
      </button>
      <div className={"search-bar" + (open ? " open" : "")} aria-label="search">
        <Magnifer className="search-icon" width={20} height={20} />
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search files…"
          aria-label="search files"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <button
          className="search-clear"
          type="button"
          aria-label="close search"
          onClick={() => {
            hapticSelection();
            if (query.length > 0) {
              onQueryChange("");
              inputRef.current?.focus();
            } else {
              inputRef.current?.blur();
              onClose();
            }
          }}
        >
          <CloseCircle width={20} height={20} />
        </button>
      </div>
    </>
  );
}
