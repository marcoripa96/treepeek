import type { OutlineSymbol } from "../lib/api";

interface Props {
  symbols: OutlineSymbol[];
  activeLine: number | null;
  onJump: (line: number) => void;
}

const KIND_GLYPH: Record<string, { letter: string; color: string }> = {
  function: { letter: "ƒ", color: "#7c3aed" },
  class: { letter: "C", color: "#0ea5e9" },
  interface: { letter: "I", color: "#2563eb" },
  type: { letter: "T", color: "#0891b2" },
  enum: { letter: "E", color: "#a855f7" },
  fn: { letter: "ƒ", color: "#7c3aed" },
  struct: { letter: "S", color: "#0ea5e9" },
  trait: { letter: "T", color: "#2563eb" },
  mod: { letter: "M", color: "#94a3b8" },
  impl: { letter: "i", color: "#0891b2" },
  heading: { letter: "#", color: "#64748b" },
};

const DEFAULT_GLYPH = { letter: "·", color: "#94a3b8" };

export function OutlinePanel({ symbols, activeLine, onJump }: Props) {
  if (symbols.length === 0) {
    return (
      <div className="outline-panel">
        <div className="outline-empty">No symbols</div>
      </div>
    );
  }
  return (
    <div className="outline-panel" role="listbox" aria-label="outline">
      {symbols.map((sym, i) => {
        const glyph = KIND_GLYPH[sym.kind] ?? DEFAULT_GLYPH;
        const active = activeLine === sym.line;
        return (
          <button
            key={`${sym.line}-${i}`}
            type="button"
            role="option"
            aria-selected={active}
            className={"outline-item" + (active ? " active" : "")}
            onClick={() => onJump(sym.line)}
          >
            <span
              className="outline-kind"
              style={{ color: glyph.color }}
              aria-hidden="true"
            >
              {glyph.letter}
            </span>
            <span
              className="outline-name"
              style={{ paddingLeft: sym.depth * 12 }}
            >
              {sym.name}
            </span>
            <span className="outline-line">{sym.line}</span>
          </button>
        );
      })}
    </div>
  );
}
