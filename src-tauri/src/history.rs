use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::dedupe::{decide, Decision};

const SCHEMA_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub original: String,
    pub modified: String,
    pub preview: String,
    pub language: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryFile {
    pub version: u32,
    pub entries: Vec<HistoryEntry>,
}

impl Default for HistoryFile {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

pub struct HistoryStore {
    pub file: HistoryFile,
    pub path: Option<PathBuf>,
}

impl HistoryStore {
    pub fn new_in_memory() -> Self {
        Self {
            file: HistoryFile::default(),
            path: None,
        }
    }

    pub async fn load_from_app_dir(handle: &AppHandle) -> Result<Self> {
        let dir = handle
            .path()
            .app_data_dir()
            .context("resolve app_data_dir")?;
        fs::create_dir_all(&dir).await.ok();
        let path = dir.join("history.json");

        let file = if path.exists() {
            let bytes = fs::read(&path).await.context("read history.json")?;
            serde_json::from_slice::<HistoryFile>(&bytes).unwrap_or_default()
        } else {
            HistoryFile::default()
        };

        Ok(Self {
            file,
            path: Some(path),
        })
    }

    pub fn entries(&self) -> &[HistoryEntry] {
        &self.file.entries
    }

    pub async fn capture(
        &mut self,
        original: String,
        modified: String,
        language: String,
        force: bool,
    ) -> Result<()> {
        if should_skip(&original, &modified) {
            return Ok(());
        }

        let now = Utc::now();
        let candidate_preview = make_preview(&original, &modified);

        let last = self.file.entries.last();

        let decision = if force {
            Decision::Append
        } else {
            decide(last, &original, &modified, now)
        };

        match decision {
            Decision::UpdateLast => {
                if let Some(entry) = self.file.entries.last_mut() {
                    entry.original = original;
                    entry.modified = modified;
                    entry.updated_at = now;
                    entry.preview = candidate_preview;
                    entry.language = language;
                }
            }
            Decision::Append => {
                let entry = HistoryEntry {
                    id: Uuid::new_v4().to_string(),
                    created_at: now,
                    updated_at: now,
                    original,
                    modified,
                    preview: candidate_preview,
                    language,
                };
                self.file.entries.push(entry);
                if self.file.entries.len() > MAX_ENTRIES {
                    let overflow = self.file.entries.len() - MAX_ENTRIES;
                    self.file.entries.drain(0..overflow);
                }
            }
        }

        self.persist().await?;
        Ok(())
    }

    pub async fn delete(&mut self, id: &str) -> Result<()> {
        self.file.entries.retain(|e| e.id != id);
        self.persist().await?;
        Ok(())
    }

    pub async fn clear(&mut self) -> Result<()> {
        self.file.entries.clear();
        self.persist().await?;
        Ok(())
    }

    async fn persist(&self) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(()); // in-memory only
        };
        let bytes = serde_json::to_vec_pretty(&self.file)?;
        let tmp = path.with_extension("json.tmp");
        {
            let mut f = fs::File::create(&tmp).await.context("create tmp")?;
            f.write_all(&bytes).await.context("write tmp")?;
            f.sync_all().await.ok();
        }
        fs::rename(&tmp, path).await.context("rename tmp -> final")?;
        Ok(())
    }
}

fn should_skip(original: &str, modified: &str) -> bool {
    if original.is_empty() && modified.is_empty() {
        return true;
    }
    if original == modified {
        return true;
    }
    if original.len() < 2 && modified.len() < 2 {
        return true;
    }
    false
}

fn make_preview(original: &str, modified: &str) -> String {
    let source = if !modified.is_empty() { modified } else { original };
    let first_line = source.lines().next().unwrap_or("");
    let trimmed = first_line.trim();
    if trimmed.chars().count() <= 80 {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(80).collect();
        s.push('…');
        s
    }
}
