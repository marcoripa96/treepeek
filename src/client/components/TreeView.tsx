import { useEffect, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";

interface Props {
  paths: string[];
  gitStatus: GitStatusEntry[] | null;
  onOpenFile: (path: string) => void;
  hidden: boolean;
}

export function TreeView({ paths, gitStatus, onOpenFile, hidden }: Props) {
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    search: false,
    flattenEmptyDirectories: true,
    density: "relaxed",
    gitStatus: gitStatus ?? undefined,
  });

  const skipFirstPaths = useRef(true);
  useEffect(() => {
    if (skipFirstPaths.current) {
      skipFirstPaths.current = false;
      return;
    }
    model.resetPaths(paths);
  }, [model, paths]);

  const skipFirstGit = useRef(true);
  useEffect(() => {
    if (skipFirstGit.current) {
      skipFirstGit.current = false;
      return;
    }
    model.setGitStatus(gitStatus ?? undefined);
  }, [model, gitStatus]);

  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    const native = event.nativeEvent as MouseEvent;
    for (const node of native.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      const path = node.dataset.itemPath;
      const type = node.dataset.itemType;
      if (path && type === "file") {
        onOpenFileRef.current(path);
        return;
      }
    }
  };

  return (
    <FileTree
      id="tree"
      className="tp-tree-host"
      model={model}
      onClick={handleClick}
      style={hidden ? { display: "none", pointerEvents: "none" } : undefined}
    />
  );
}
