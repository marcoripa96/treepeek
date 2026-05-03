use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use serde::Serialize;
use tokio::sync::mpsc;

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

const RING_CAPACITY: usize = 100;

#[derive(Serialize, Clone, Debug)]
pub struct FsEvent {
    pub path: String,
    pub kind: &'static str,
    pub ts: String,
}

#[derive(Default)]
pub struct EventRing {
    inner: Mutex<VecDeque<FsEvent>>,
}

impl EventRing {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
        })
    }

    fn push_many(&self, events: &[FsEvent]) {
        let mut g = self.inner.lock().unwrap();
        for ev in events {
            if g.len() == RING_CAPACITY {
                g.pop_front();
            }
            g.push_back(ev.clone());
        }
    }

    pub fn snapshot(&self) -> Vec<FsEvent> {
        let g = self.inner.lock().unwrap();
        g.iter().cloned().collect()
    }
}

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
    false
}

fn classify_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Remove(_) => "remove",
        EventKind::Modify(_) => "modify",
        _ => "other",
    }
}

pub fn start(
    root: PathBuf,
    include_all: bool,
    ring: Arc<EventRing>,
    on_change: Arc<dyn Fn(Vec<FsEvent>) + Send + Sync>,
    on_refs_change: Option<Arc<dyn Fn() + Send + Sync>>,
) -> notify::Result<Watcher> {
    let debounce = Duration::from_millis(200);
    let ignored_owned: Arc<HashSet<String>> = Arc::new(if include_all {
        HashSet::new()
    } else {
        DEFAULT_IGNORED_TOP.iter().map(|s| s.to_string()).collect()
    });

    let (path_tx, mut path_rx) = mpsc::unbounded_channel::<FsEvent>();
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
            let kind = classify_kind(&event.kind);
            let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            for path in &event.paths {
                let rel = match path.strip_prefix(&root_main) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let hit = rel.components().any(|c| {
                    c.as_os_str()
                        .to_str()
                        .map(|s| ignored_for_cb.contains(s))
                        .unwrap_or(false)
                });
                if hit {
                    continue;
                }
                let basename = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if is_noise(basename) {
                    continue;
                }
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if rel_str.is_empty() {
                    continue;
                }
                let _ = path_tx.send(FsEvent {
                    path: rel_str,
                    kind,
                    ts: now.clone(),
                });
            }
        },
        notify::Config::default(),
    )?;
    main_watcher.watch(&root, RecursiveMode::Recursive)?;

    let on_change_task = on_change.clone();
    let ring_for_task = ring.clone();
    tokio::spawn(async move {
        let mut pending: Vec<FsEvent> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            let first = match path_rx.recv().await {
                Some(p) => p,
                None => return,
            };
            seen.insert(first.path.clone());
            pending.push(first);
            loop {
                tokio::select! {
                    v = path_rx.recv() => {
                        match v {
                            Some(p) => {
                                if seen.insert(p.path.clone()) {
                                    pending.push(p);
                                }
                            }
                            None => return,
                        }
                    }
                    _ = tokio::time::sleep(debounce) => break,
                }
            }
            let drained: Vec<FsEvent> = pending.drain(..).collect();
            seen.clear();
            ring_for_task.push_many(&drained);
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
