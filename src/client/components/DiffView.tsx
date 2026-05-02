import { useEffect, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { fetchDiff } from "../lib/api";

interface Props {
  path: string;
  ws: number | null;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; reason?: string }
  | { kind: "ready"; patch: string };

export function DiffView({ path, ws }: Props) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    setState({ kind: "loading" });
    const abort = new AbortController();
    (async () => {
      try {
        const data = await fetchDiff(path, ws, abort.signal);
        if (!data.hasChanges || data.patch.length === 0) {
          setState({ kind: "empty", reason: data.reason });
          return;
        }
        setState({ kind: "ready", patch: data.patch });
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load diff.",
        });
      }
    })();
    return () => abort.abort();
  }, [path, ws]);

  if (state.kind === "loading") {
    return <div className="sheet-empty">Loading diff…</div>;
  }
  if (state.kind === "error") {
    return <div className="sheet-empty">{state.message}</div>;
  }
  if (state.kind === "empty") {
    return (
      <div className="sheet-empty">
        {state.reason ?? "No changes to show."}
      </div>
    );
  }
  return (
    <div className="diff-host">
      <PatchDiff patch={state.patch} disableWorkerPool />
    </div>
  );
}
