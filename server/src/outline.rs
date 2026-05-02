use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
pub struct OutlineSymbol {
    pub name: String,
    pub kind: String,
    pub line: usize,
    pub depth: usize,
}

#[derive(Serialize, Debug, Clone)]
pub struct OutlineLink {
    pub line: usize,
    pub target: String,
}

#[derive(Serialize, Debug, Default)]
pub struct Outline {
    pub symbols: Vec<OutlineSymbol>,
    pub links: Vec<OutlineLink>,
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum Lang {
    Ts,
    Js,
    Rust,
    Python,
    Markdown,
    Go,
    Other,
}

fn detect_lang(rel_path: &str) -> Lang {
    let lower = rel_path.to_ascii_lowercase();
    let after_dot = lower.rsplit('.').next().unwrap_or("");
    match after_dot {
        "ts" | "tsx" | "mts" | "cts" => Lang::Ts,
        "js" | "jsx" | "mjs" | "cjs" => Lang::Js,
        "rs" => Lang::Rust,
        "py" => Lang::Python,
        "md" | "markdown" => Lang::Markdown,
        "go" => Lang::Go,
        _ => Lang::Other,
    }
}

pub fn build(content: &str, rel_path: &str, paths: &HashSet<String>) -> Outline {
    let lang = detect_lang(rel_path);
    let mut out = Outline::default();
    match lang {
        Lang::Ts | Lang::Js => {
            scan_ts_js(content, &mut out.symbols);
            scan_ts_js_imports(content, rel_path, paths, &mut out.links);
        }
        Lang::Rust => {
            scan_rust(content, &mut out.symbols);
            scan_rust_mods(content, rel_path, paths, &mut out.links);
        }
        Lang::Python => scan_python(content, &mut out.symbols),
        Lang::Markdown => scan_markdown(content, &mut out.symbols),
        Lang::Go => scan_go(content, &mut out.symbols),
        Lang::Other => {}
    }
    out
}

fn indent_depth(line: &str) -> usize {
    let mut spaces = 0usize;
    for ch in line.chars() {
        match ch {
            ' ' => spaces += 1,
            '\t' => spaces += 4,
            _ => break,
        }
    }
    (spaces / 2).min(8)
}

fn ts_js_re() -> &'static [(Regex, &'static str)] {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        vec![
            (
                Regex::new(
                    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)",
                )
                .unwrap(),
                "function",
            ),
            (
                Regex::new(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)")
                    .unwrap(),
                "class",
            ),
            (
                Regex::new(r"^\s*(?:export\s+)?interface\s+(\w+)").unwrap(),
                "interface",
            ),
            (
                Regex::new(r"^\s*(?:export\s+)?type\s+(\w+)\s*[=<]").unwrap(),
                "type",
            ),
            (
                Regex::new(r"^\s*(?:export\s+)?enum\s+(\w+)").unwrap(),
                "enum",
            ),
            (
                Regex::new(
                    r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b|<\w)",
                )
                .unwrap(),
                "function",
            ),
        ]
    })
}

fn scan_ts_js(content: &str, out: &mut Vec<OutlineSymbol>) {
    for (i, line) in content.lines().enumerate() {
        for (re, kind) in ts_js_re() {
            if let Some(caps) = re.captures(line) {
                if let Some(name) = caps.get(1).map(|m| m.as_str()) {
                    out.push(OutlineSymbol {
                        name: name.to_string(),
                        kind: (*kind).to_string(),
                        line: i + 1,
                        depth: indent_depth(line),
                    });
                    break;
                }
            }
        }
    }
}

fn ts_js_import_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r#"^\s*(?:import\b[^'"]*?from\s*|import\s*|export\s+[\w*{}\s,]+\s+from\s*|(?:require|import)\s*\(\s*)['"]([^'"]+)['"]"#,
        )
        .unwrap()
    })
}

fn scan_ts_js_imports(
    content: &str,
    rel_path: &str,
    paths: &HashSet<String>,
    out: &mut Vec<OutlineLink>,
) {
    let re = ts_js_import_re();
    for (i, line) in content.lines().enumerate() {
        if let Some(caps) = re.captures(line) {
            if let Some(spec) = caps.get(1).map(|m| m.as_str()) {
                if !is_relative_specifier(spec) {
                    continue;
                }
                if let Some(target) = resolve_ts_js(rel_path, spec, paths) {
                    out.push(OutlineLink {
                        line: i + 1,
                        target,
                    });
                }
            }
        }
    }
}

fn is_relative_specifier(s: &str) -> bool {
    s.starts_with("./") || s.starts_with("../")
}

fn dirname(rel_path: &str) -> &str {
    match rel_path.rfind('/') {
        Some(i) => &rel_path[..i],
        None => "",
    }
}

fn join_normalize(base_dir: &str, spec: &str) -> String {
    let combined = if base_dir.is_empty() {
        spec.to_string()
    } else {
        format!("{}/{}", base_dir, spec)
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn resolve_ts_js(rel_path: &str, spec: &str, paths: &HashSet<String>) -> Option<String> {
    let base = dirname(rel_path);
    let joined = join_normalize(base, spec);
    if joined.is_empty() {
        return None;
    }
    let exts = [
        "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json",
    ];
    for ext in &exts {
        let candidate = format!("{}{}", joined, ext);
        if paths.contains(&candidate) {
            return Some(candidate);
        }
    }
    let index_exts = [
        "/index.ts",
        "/index.tsx",
        "/index.js",
        "/index.jsx",
        "/index.mjs",
        "/index.cjs",
    ];
    for ext in &index_exts {
        let candidate = format!("{}{}", joined, ext);
        if paths.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn rust_re() -> &'static [(Regex, &'static str)] {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        vec![
            (
                Regex::new(
                    r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)",
                )
                .unwrap(),
                "fn",
            ),
            (
                Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)").unwrap(),
                "struct",
            ),
            (
                Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)").unwrap(),
                "enum",
            ),
            (
                Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)").unwrap(),
                "trait",
            ),
            (
                Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)").unwrap(),
                "type",
            ),
            (
                Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)").unwrap(),
                "mod",
            ),
            (
                Regex::new(r"^\s*impl(?:\s*<[^>]*>)?\s+([^{]+?)\s*\{?\s*$").unwrap(),
                "impl",
            ),
        ]
    })
}

fn scan_rust(content: &str, out: &mut Vec<OutlineSymbol>) {
    for (i, line) in content.lines().enumerate() {
        for (re, kind) in rust_re() {
            if let Some(caps) = re.captures(line) {
                if let Some(name) = caps.get(1).map(|m| m.as_str().trim().to_string()) {
                    out.push(OutlineSymbol {
                        name,
                        kind: (*kind).to_string(),
                        line: i + 1,
                        depth: indent_depth(line),
                    });
                    break;
                }
            }
        }
    }
}

fn rust_mod_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;").unwrap())
}

fn scan_rust_mods(
    content: &str,
    rel_path: &str,
    paths: &HashSet<String>,
    out: &mut Vec<OutlineLink>,
) {
    let re = rust_mod_re();
    let base = dirname(rel_path);
    let stem = std::path::Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    for (i, line) in content.lines().enumerate() {
        if let Some(caps) = re.captures(line) {
            if let Some(name) = caps.get(1).map(|m| m.as_str()) {
                let candidates = [
                    format!("{}/{}.rs", base, name),
                    format!("{}/{}/mod.rs", base, name),
                    format!("{}/{}/{}.rs", base, stem, name),
                ];
                for c in &candidates {
                    let normalized = join_normalize("", c);
                    if paths.contains(&normalized) {
                        out.push(OutlineLink {
                            line: i + 1,
                            target: normalized,
                        });
                        break;
                    }
                }
            }
        }
    }
}

fn python_re() -> &'static [(Regex, &'static str)] {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        vec![
            (
                Regex::new(r"^(?P<indent>\s*)(?:async\s+)?def\s+(\w+)").unwrap(),
                "function",
            ),
            (
                Regex::new(r"^(?P<indent>\s*)class\s+(\w+)").unwrap(),
                "class",
            ),
        ]
    })
}

fn scan_python(content: &str, out: &mut Vec<OutlineSymbol>) {
    for (i, line) in content.lines().enumerate() {
        for (re, kind) in python_re() {
            if let Some(caps) = re.captures(line) {
                if let Some(name) = caps.get(2).map(|m| m.as_str()) {
                    out.push(OutlineSymbol {
                        name: name.to_string(),
                        kind: (*kind).to_string(),
                        line: i + 1,
                        depth: indent_depth(line),
                    });
                    break;
                }
            }
        }
    }
}

fn markdown_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*$").unwrap())
}

fn scan_markdown(content: &str, out: &mut Vec<OutlineSymbol>) {
    let re = markdown_re();
    for (i, line) in content.lines().enumerate() {
        if let Some(caps) = re.captures(line) {
            let level = caps.get(1).map(|m| m.as_str().len()).unwrap_or(1);
            let name = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
            out.push(OutlineSymbol {
                name,
                kind: "heading".to_string(),
                line: i + 1,
                depth: level.saturating_sub(1),
            });
        }
    }
}

fn go_re() -> &'static [(Regex, &'static str)] {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        vec![
            (
                Regex::new(r"^func\s+(?:\([^)]+\)\s+)?(\w+)").unwrap(),
                "function",
            ),
            (Regex::new(r"^type\s+(\w+)\s+(?:struct|interface)\b").unwrap(), "type"),
        ]
    })
}

fn scan_go(content: &str, out: &mut Vec<OutlineSymbol>) {
    for (i, line) in content.lines().enumerate() {
        for (re, kind) in go_re() {
            if let Some(caps) = re.captures(line) {
                if let Some(name) = caps.get(1).map(|m| m.as_str()) {
                    out.push(OutlineSymbol {
                        name: name.to_string(),
                        kind: (*kind).to_string(),
                        line: i + 1,
                        depth: 0,
                    });
                    break;
                }
            }
        }
    }
}
