import { createHighlighterCoreSync, type HighlighterCore, type ShikiTransformer } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubLight from "@shikijs/themes/github-light";

import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import dockerfile from "@shikijs/langs/docker";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";

const THEME_NAME = "github-light";

const LANGS = [
  bash,
  css,
  dockerfile,
  go,
  html,
  javascript,
  json,
  jsonc,
  jsx,
  markdown,
  python,
  rust,
  scss,
  sql,
  toml,
  tsx,
  typescript,
  xml,
  yaml,
];

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".cts": "typescript",
  ".mts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "jsonc",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".md": "markdown",
  ".markdown": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".sql": "sql",
  ".xml": "xml",
  ".svg": "xml",
};

const FILENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "docker",
  "tsconfig.json": "jsonc",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".bash_profile": "bash",
};

let highlighter: HighlighterCore | null = null;
function getHighlighter(): HighlighterCore {
  if (!highlighter) {
    highlighter = createHighlighterCoreSync({
      themes: [githubLight],
      langs: LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighter;
}

export function detectLang(path: string): string | null {
  const filename = path.split("/").pop() ?? "";
  if (FILENAME_TO_LANG[filename]) return FILENAME_TO_LANG[filename]!;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_LANG[filename.slice(dot).toLowerCase()] ?? null;
}

const lineNumberTransformer: ShikiTransformer = {
  name: "treepeek:line-numbers",
  line(node, line) {
    const original = node.children;
    node.children = [
      {
        type: "element",
        tagName: "span",
        properties: { class: "ln-num" },
        children: [{ type: "text", value: String(line) }],
      },
      {
        type: "element",
        tagName: "span",
        properties: { class: "ln-content" },
        children: original,
      },
    ];
  },
};

export function highlight(code: string, path: string): string | null {
  const lang = detectLang(path);
  if (!lang) return null;
  try {
    return getHighlighter().codeToHtml(code, {
      lang,
      theme: THEME_NAME,
      transformers: [lineNumberTransformer],
    });
  } catch {
    return null;
  }
}
