use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use tokio::sync::mpsc;

const HISTORY_DB_NAME: &str = ".treepeek-history.sqlite";

const DEFAULT_IGNORED_TOP: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    ".turbo",
    ".cache",
    "dist",
    "build",
    ".svelte-kit",
    ".nuxt",
    "coverage",
    ".vercel",
    ".output",
    ".parcel-cache",
    "out",
    "target",
    "__pycache__",
];

pub struct Watcher {
    _main: RecommendedWatcher,
    _refs: Option<RecommendedWatcher>,
}

fn is_noise(basename: &str) -> bool {
    if basename.is_empty() {
        return true;
    }
    if basename == "4913" {
        return true;
    }
    if basename.ends_with('~') {
        return true;
    }
    if basename.ends_with(".swp") || basename.ends_with(".swo") || basename.ends_with(".swx") {
        return true;
    }
    if basename.starts_with(".#") {
        return true;
    }
    if basename == HISTORY_DB_NAME
        || basename == ".treepeek-history.sqlite-wal"
        || basename == ".treepeek-history.sqlite-shm"
    {
        return true;
    }
    false
}

pub fn start(
    root: PathBuf,
    include_all: bool,
    on_change: Arc<dyn Fn(Vec<String>) + Send + Sync>,
    on_refs_change: Option<Arc<dyn Fn() + Send + Sync>>,
) -> notify::Result<Watcher> {
    let debounce = Duration::from_millis(200);
    let ignored_owned: Arc<HashSet<String>> = Arc::new(if include_all {
        HashSet::new()
    } else {
        DEFAULT_IGNORED_TOP.iter().map(|s| s.to_string()).collect()
    });

    let (path_tx, mut path_rx) = mpsc::unbounded_channel::<String>();
    let root_main = root.clone();
    let ignored_for_cb = ignored_owned.clone();

    let mut main_watcher: RecommendedWatcher = NotifyWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else {
                return;
            };
            if !matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                return;
            }
            for path in &event.paths {
                if let Ok(rel) = path.strip_prefix(&root_main) {
                    let hit = rel.components().any(|c| {
                        c.as_os_str()
                            .to_str()
                            .map(|s| ignored_for_cb.contains(s))
                            .unwrap_or(false)
                    });
                    if hit {
                        continue;
                    }
                }
                let basename = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if is_noise(basename) {
                    continue;
                }
                if let Some(s) = path.to_str() {
                    let _ = path_tx.send(s.to_string());
                }
            }
        },
        notify::Config::default(),
    )?;
    main_watcher.watch(&root, RecursiveMode::Recursive)?;

    let on_change_task = on_change.clone();
    tokio::spawn(async move {
        let mut pending: HashSet<String> = HashSet::new();
        loop {
            let first = match path_rx.recv().await {
                Some(p) => p,
                None => return,
            };
            pending.insert(first);
            loop {
                tokio::select! {
                    v = path_rx.recv() => {
                        match v {
                            Some(p) => { pending.insert(p); }
                            None => return,
                        }
                    }
                    _ = tokio::time::sleep(debounce) => break,
                }
            }
            let drained: Vec<String> = pending.drain().collect();
            on_change_task(drained);
        }
    });

    let mut refs_watcher: Option<RecommendedWatcher> = None;
    if let Some(refs_cb) = on_refs_change {
        let git_dir = root.join(".git");
        if git_dir.is_dir() {
            let targets: Vec<PathBuf> = ["HEAD", "logs", "refs", "packed-refs"]
                .iter()
                .map(|p| git_dir.join(p))
                .filter(|p| p.exists())
                .collect();
            if !targets.is_empty() {
                let (refs_tx, mut refs_rx) = mpsc::unbounded_channel::<()>();
                let refs_tx_inner = refs_tx.clone();
                let mut w: RecommendedWatcher = NotifyWatcher::new(
                    move |res: Result<Event, notify::Error>| {
                        if res.is_ok() {
                            let _ = refs_tx_inner.send(());
                        }
                    },
                    notify::Config::default(),
                )?;
                let mut any_ok = false;
                for t in &targets {
                    let mode = if t.is_dir() {
                        RecursiveMode::Recursive
                    } else {
                        RecursiveMode::NonRecursive
                    };
                    if w.watch(t, mode).is_ok() {
                        any_ok = true;
                    }
                }
                if any_ok {
                    let cb = refs_cb.clone();
                    tokio::spawn(async move {
                        loop {
                            if refs_rx.recv().await.is_none() {
                                return;
                            }
                            loop {
                                tokio::select! {
                                    v = refs_rx.recv() => {
                                        if v.is_none() { return; }
                                    }
                                    _ = tokio::time::sleep(debounce) => break,
                                }
                            }
                            cb();
                        }
                    });
                    refs_watcher = Some(w);
                }
                drop(refs_tx);
            }
        }
    }

    Ok(Watcher {
        _main: main_watcher,
        _refs: refs_watcher,
    })
}
