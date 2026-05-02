use std::path::{Path, PathBuf};

use fff_search::file_picker::FilePicker;
use fff_search::frecency::FrecencyTracker;
use fff_search::{
    FFFMode, FilePickerOptions, FuzzySearchOptions, PaginationArgs, QueryParser, SharedFrecency,
    SharedPicker,
};

pub struct SearchService {
    picker: SharedPicker,
    frecency: SharedFrecency,
    base_path: PathBuf,
}

#[derive(serde::Serialize)]
pub struct SearchHit {
    pub path: String,
    pub score: i64,
    #[serde(rename = "exactMatch")]
    pub exact_match: bool,
}

impl SearchService {
    pub fn init(root: &Path, frecency_db: Option<PathBuf>) -> Result<Self, String> {
        let picker = SharedPicker::default();
        let frecency = SharedFrecency::default();

        if let Some(db_path) = frecency_db {
            if let Some(parent) = db_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match FrecencyTracker::new(&db_path, false) {
                Ok(tracker) => {
                    let _ = frecency.init(tracker);
                    let _ = frecency.spawn_gc(db_path.to_string_lossy().into_owned(), false);
                }
                Err(e) => {
                    eprintln!("[treepeek] frecency db unavailable: {}", e);
                }
            }
        }

        FilePicker::new_with_shared_state(
            picker.clone(),
            frecency.clone(),
            FilePickerOptions {
                base_path: root.to_string_lossy().into_owned(),
                mode: FFFMode::Ai,
                ..Default::default()
            },
        )
        .map_err(|e| format!("file picker init: {}", e))?;

        Ok(Self {
            picker,
            frecency,
            base_path: root.to_path_buf(),
        })
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        let guard = match self.picker.read() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        let Some(picker) = guard.as_ref() else {
            return Vec::new();
        };
        let parser = QueryParser::default();
        let parsed = parser.parse(q);
        let opts = FuzzySearchOptions {
            max_threads: 0,
            current_file: None,
            pagination: PaginationArgs { offset: 0, limit },
            ..Default::default()
        };
        let result = picker.fuzzy_search(&parsed, None, opts);
        result
            .items
            .iter()
            .zip(result.scores.iter())
            .map(|(item, score)| SearchHit {
                path: item.relative_path(picker),
                score: score.total as i64,
                exact_match: score.exact_match,
            })
            .collect()
    }

    pub fn track_access(&self, rel_path: &str) {
        let abs = self.base_path.join(rel_path);
        let guard = match self.frecency.read() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(tracker) = guard.as_ref() {
            let _ = tracker.track_access(&abs);
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.picker.write() {
            if let Some(picker) = guard.as_mut() {
                picker.stop_background_monitor();
            }
        }
    }
}
