use crate::utils::{app_store_root, now_ms};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tracing_subscriber::filter::LevelFilter;
use uuid::Uuid;

const ACTIVE_LOG_NAME: &str = "rakh.log";
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;
const LOG_ARCHIVE_COUNT: usize = 5;
const DEFAULT_QUERY_LIMIT: usize = 500;

static LOG_STORE: OnceLock<Arc<LogStore>> = OnceLock::new();
static TRACING_INIT: OnceLock<()> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogSource {
    Backend,
    Frontend,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Start,
    End,
    Event,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TagMode {
    And,
    Or,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub timestamp_ms: i64,
    pub level: LogLevel,
    pub source: LogSource,
    pub tags: Vec<String>,
    pub event: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub depth: u32,
    pub kind: LogKind,
    pub expandable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogQueryFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_mode: Option<TagMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub levels: Option<Vec<LogLevel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<LogSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogExportResult {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogClearResult {
    pub removed_files: usize,
}

#[derive(Debug)]
pub struct LogStore {
    logs_dir: PathBuf,
    exports_dir: PathBuf,
    active_path: PathBuf,
    app_handle: Mutex<Option<AppHandle>>,
    write_lock: Mutex<()>,
}

impl LogStore {
    pub fn new(logs_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&logs_dir)
            .map_err(|error| format!("Cannot create logs dir {}: {}", logs_dir.display(), error))?;
        let exports_dir = logs_dir.join("exports");
        fs::create_dir_all(&exports_dir).map_err(|error| {
            format!(
                "Cannot create log export dir {}: {}",
                exports_dir.display(),
                error
            )
        })?;

        Ok(Self {
            active_path: logs_dir.join(ACTIVE_LOG_NAME),
            logs_dir,
            exports_dir,
            app_handle: Mutex::new(None),
            write_lock: Mutex::new(()),
        })
    }

    pub fn runtime_logs_dir() -> Result<PathBuf, String> {
        Ok(app_store_root()?.join("logs"))
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(app_handle);
    }

    pub fn active_path(&self) -> &Path {
        &self.active_path
    }

    fn archived_path(&self, index: usize) -> PathBuf {
        self.logs_dir.join(format!("{}.{}", ACTIVE_LOG_NAME, index))
    }

    fn all_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![self.active_path.clone()];
        for index in 1..=LOG_ARCHIVE_COUNT {
            paths.push(self.archived_path(index));
        }
        paths
    }

    fn rotate_if_needed(&self, pending_bytes: u64) -> Result<(), String> {
        let current_size = fs::metadata(&self.active_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_size + pending_bytes <= LOG_ROTATE_BYTES {
            return Ok(());
        }

        let oldest = self.archived_path(LOG_ARCHIVE_COUNT);
        if oldest.exists() {
            fs::remove_file(&oldest).map_err(|error| {
                format!("Cannot remove archived log {}: {}", oldest.display(), error)
            })?;
        }

        for index in (1..LOG_ARCHIVE_COUNT).rev() {
            let src = self.archived_path(index);
            if !src.exists() {
                continue;
            }
            let dst = self.archived_path(index + 1);
            fs::rename(&src, &dst).map_err(|error| {
                format!(
                    "Cannot rotate log archive {} -> {}: {}",
                    src.display(),
                    dst.display(),
                    error
                )
            })?;
        }

        if self.active_path.exists() {
            let dst = self.archived_path(1);
            fs::rename(&self.active_path, &dst).map_err(|error| {
                format!(
                    "Cannot rotate active log {} -> {}: {}",
                    self.active_path.display(),
                    dst.display(),
                    error
                )
            })?;
        }

        Ok(())
    }

    pub fn append_entry(&self, entry: LogEntry) -> Result<(), String> {
        let _guard = self.write_lock.lock().unwrap();
        let normalized = normalize_entry(entry);
        let line = serde_json::to_string(&normalized)
            .map_err(|error| format!("Cannot serialize log entry: {}", error))?;
        self.rotate_if_needed((line.len() + 1) as u64)?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.active_path)
            .map_err(|error| {
                format!(
                    "Cannot open active log {}: {}",
                    self.active_path.display(),
                    error
                )
            })?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|error| {
                format!(
                    "Cannot append to active log {}: {}",
                    self.active_path.display(),
                    error
                )
            })?;
        file.flush().map_err(|error| {
            format!(
                "Cannot flush active log {}: {}",
                self.active_path.display(),
                error
            )
        })?;

        if cfg!(debug_assertions) {
            eprintln!("{}", line);
        }

        if let Some(app_handle) = self.app_handle.lock().unwrap().clone() {
            let _ = app_handle.emit("log_entry", &normalized);
        }
        Ok(())
    }

    fn read_entries_from_path(path: &Path) -> Result<Vec<LogEntry>, String> {
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = fs::File::open(path)
            .map_err(|error| format!("Cannot open log file {}: {}", path.display(), error))?;
        let reader = BufReader::new(file);
        let mut entries = Vec::new();
        for line in reader.lines() {
            let line = line.map_err(|error| {
                format!("Cannot read log line from {}: {}", path.display(), error)
            })?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<LogEntry>(trimmed) {
                Ok(entry) => entries.push(normalize_entry(entry)),
                Err(error) => {
                    tracing::warn!(
                        target: "rakh::logging",
                        path = %path.display(),
                        error = %error,
                        "Skipping malformed log entry"
                    );
                }
            }
        }
        Ok(entries)
    }

    pub fn load_entries(&self) -> Result<Vec<LogEntry>, String> {
        let _guard = self.write_lock.lock().unwrap();
        let mut entries = Vec::new();
        for path in self.all_paths() {
            entries.extend(Self::read_entries_from_path(&path)?);
        }
        entries.sort_by(|left, right| {
            right
                .timestamp_ms
                .cmp(&left.timestamp_ms)
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(entries)
    }

    pub fn query(&self, filter: LogQueryFilter) -> Result<Vec<LogEntry>, String> {
        let limit = filter.limit.unwrap_or(DEFAULT_QUERY_LIMIT);
        let tag_mode = filter.tag_mode.unwrap_or(TagMode::Or);
        let filter_tags = normalize_tags(filter.tags.unwrap_or_default());
        let entries = self
            .load_entries()?
            .into_iter()
            .filter(|entry| {
                if let Some(source) = &filter.source {
                    if &entry.source != source {
                        return false;
                    }
                }
                if let Some(levels) = &filter.levels {
                    if !levels.contains(&entry.level) {
                        return false;
                    }
                }
                if let Some(trace_id) = &filter.trace_id {
                    if entry.trace_id.as_deref() != Some(trace_id.as_str()) {
                        return false;
                    }
                }
                if let Some(correlation_id) = &filter.correlation_id {
                    if entry.correlation_id.as_deref() != Some(correlation_id.as_str()) {
                        return false;
                    }
                }
                if let Some(since_ms) = filter.since_ms {
                    if entry.timestamp_ms < since_ms {
                        return false;
                    }
                }
                if let Some(until_ms) = filter.until_ms {
                    if entry.timestamp_ms > until_ms {
                        return false;
                    }
                }
                if filter_tags.is_empty() {
                    return true;
                }
                match tag_mode {
                    TagMode::And => filter_tags.iter().all(|tag| entry.tags.contains(tag)),
                    TagMode::Or => filter_tags.iter().any(|tag| entry.tags.contains(tag)),
                }
            })
            .take(limit)
            .collect();
        Ok(entries)
    }

    pub fn export(&self, filter: LogQueryFilter) -> Result<LogExportResult, String> {
        fs::create_dir_all(&self.exports_dir).map_err(|error| {
            format!(
                "Cannot create log export dir {}: {}",
                self.exports_dir.display(),
                error
            )
        })?;
        let entries = self.query(filter)?;
        let export_path = self
            .exports_dir
            .join(format!("rakh-logs-{}.jsonl", now_ms()));
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&export_path)
            .map_err(|error| {
                format!(
                    "Cannot create log export {}: {}",
                    export_path.display(),
                    error
                )
            })?;
        for entry in &entries {
            let line = serde_json::to_string(entry)
                .map_err(|error| format!("Cannot serialize log entry: {}", error))?;
            file.write_all(line.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
                .map_err(|error| {
                    format!(
                        "Cannot write log export {}: {}",
                        export_path.display(),
                        error
                    )
                })?;
        }
        file.flush().map_err(|error| {
            format!(
                "Cannot flush log export {}: {}",
                export_path.display(),
                error
            )
        })?;
        Ok(LogExportResult {
            path: export_path.to_string_lossy().to_string(),
            count: entries.len(),
        })
    }

    pub fn clear(&self) -> Result<LogClearResult, String> {
        let _guard = self.write_lock.lock().unwrap();
        let mut removed_files = 0usize;
        for path in self.all_paths() {
            if !path.exists() {
                continue;
            }
            fs::remove_file(&path)
                .map_err(|error| format!("Cannot remove log file {}: {}", path.display(), error))?;
            removed_files += 1;
        }
        Ok(LogClearResult { removed_files })
    }
}

fn current_timestamp_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = tags
        .into_iter()
        .map(|tag| tag.trim().to_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn normalize_entry(mut entry: LogEntry) -> LogEntry {
    if entry.id.trim().is_empty() {
        entry.id = format!("log_{}", Uuid::new_v4().simple());
    }
    if entry.timestamp_ms <= 0 {
        entry.timestamp_ms = now_ms();
    }
    if entry.timestamp.trim().is_empty() {
        entry.timestamp = current_timestamp_string();
    }
    if entry.event.trim().is_empty() {
        entry.event = "log.event".to_string();
    }
    if entry.message.trim().is_empty() {
        entry.message = entry.event.clone();
    }
    entry.tags = normalize_tags(entry.tags);
    if matches!(entry.data, Some(Value::Null)) {
        entry.data = None;
    }
    entry
}

fn runtime_store() -> Result<&'static Arc<LogStore>, String> {
    LOG_STORE
        .get()
        .ok_or_else(|| "Structured logging is not initialized".to_string())
}

fn default_backend_message(tool: &str, event: &str, data: &Map<String, Value>) -> String {
    match event {
        "start" => format!("{} started", tool),
        "ok" => format!("{} completed", tool),
        "err" => data
            .get("error")
            .and_then(Value::as_str)
            .map(|error| format!("{} failed: {}", tool, error))
            .unwrap_or_else(|| format!("{} failed", tool)),
        _ => format!("{} {}", tool, event),
    }
}

fn infer_backend_tags(tool: &str) -> Vec<String> {
    let mut tags = vec!["backend".to_string(), "tool-calls".to_string()];
    if tool.starts_with("db_")
        || tool.starts_with("providers_")
        || tool.starts_with("profiles_")
        || tool.starts_with("command_list_")
        || tool == "load_provider_env_api_keys"
    {
        tags.push("db".to_string());
    } else {
        tags.push("system".to_string());
    }
    tags
}

fn infer_kind(event: &str) -> LogKind {
    match event {
        "start" => LogKind::Start,
        "ok" => LogKind::End,
        "err" => LogKind::Error,
        _ => LogKind::Event,
    }
}

fn infer_level(event: &str) -> LogLevel {
    match event {
        "err" => LogLevel::Error,
        _ => LogLevel::Info,
    }
}

fn duration_from_map(data: &mut Map<String, Value>) -> Option<u64> {
    data.remove("durationMs").and_then(|value| value.as_u64())
}

fn data_from_fields(fields: Value) -> Option<Value> {
    match fields {
        Value::Null => None,
        Value::Object(map) if map.is_empty() => None,
        Value::Object(map) => Some(Value::Object(map)),
        other => Some(json!({ "data": other })),
    }
}

fn next_backend_entry_id(tool: &str, event: &str, context: Option<&LogContext>) -> String {
    if let Some(correlation_id) = context.and_then(|ctx| ctx.correlation_id.as_deref()) {
        return format!(
            "backend:{}:{}:{}",
            tool,
            event,
            correlation_id.replace(':', "_")
        );
    }
    format!("backend:{}:{}:{}", tool, event, Uuid::new_v4().simple())
}

pub fn build_backend_entry(
    tool: &str,
    event: &str,
    fields: Value,
    context: Option<&LogContext>,
) -> LogEntry {
    let mut data = match data_from_fields(fields) {
        Some(Value::Object(map)) => map,
        Some(other) => {
            let mut map = Map::new();
            map.insert("data".to_string(), other);
            map
        }
        None => Map::new(),
    };
    let duration_ms = duration_from_map(&mut data);
    let message = data
        .remove("message")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| default_backend_message(tool, event, &data));
    let kind = infer_kind(event);
    let data = if data.is_empty() {
        None
    } else {
        Some(Value::Object(data))
    };

    LogEntry {
        id: next_backend_entry_id(tool, event, context),
        timestamp: current_timestamp_string(),
        timestamp_ms: now_ms(),
        level: infer_level(event),
        source: LogSource::Backend,
        tags: infer_backend_tags(tool),
        event: format!("backend.{}.{}", tool, event),
        message,
        trace_id: context.and_then(|ctx| ctx.trace_id.clone()),
        correlation_id: context.and_then(|ctx| ctx.correlation_id.clone()),
        parent_id: context.and_then(|ctx| ctx.parent_id.clone()),
        depth: context.and_then(|ctx| ctx.depth).unwrap_or(0),
        kind: kind.clone(),
        expandable: matches!(kind, LogKind::Start) || data.is_some(),
        duration_ms,
        data,
    }
}

pub fn tool_logging_enabled() -> bool {
    true
}

pub fn write_entry(entry: LogEntry) -> Result<(), String> {
    runtime_store()?.append_entry(entry)
}

pub fn tool_log(tool: &str, event: &str, fields: Value) {
    tool_log_with_context(tool, event, fields, None);
}

pub fn tool_log_with_context(tool: &str, event: &str, fields: Value, context: Option<&LogContext>) {
    if let Err(error) = write_entry(build_backend_entry(tool, event, fields, context)) {
        tracing::error!(
            target: "rakh::logging",
            tool = %tool,
            event = %event,
            error = %error,
            "Failed to write structured backend log entry"
        );
    }
}

pub fn init_runtime_logging(app_handle: AppHandle) -> Result<Arc<LogStore>, String> {
    let logs_dir = LogStore::runtime_logs_dir()?;
    let store = if let Some(existing) = LOG_STORE.get() {
        existing.clone()
    } else {
        let created = Arc::new(LogStore::new(logs_dir)?);
        let _ = LOG_STORE.set(created.clone());
        created
    };
    store.set_app_handle(app_handle);

    TRACING_INIT.get_or_init(|| {
        let max_level = if cfg!(debug_assertions) {
            LevelFilter::DEBUG
        } else {
            LevelFilter::OFF
        };
        let _ = tracing_subscriber::fmt()
            .with_max_level(max_level)
            .json()
            .with_ansi(false)
            .with_current_span(false)
            .with_span_list(false)
            .with_target(true)
            .try_init();
    });

    tracing::info!(
        target: "rakh::logging",
        path = %store.active_path().display(),
        "Structured logging initialized"
    );

    Ok(store)
}

#[tauri::command]
pub fn logs_write(entry: LogEntry) -> Result<(), String> {
    write_entry(entry)
}

#[tauri::command]
pub fn logs_query(filter: Option<LogQueryFilter>) -> Result<Vec<LogEntry>, String> {
    runtime_store()?.query(filter.unwrap_or_default())
}

#[tauri::command]
pub fn logs_export(filter: Option<LogQueryFilter>) -> Result<LogExportResult, String> {
    runtime_store()?.export(filter.unwrap_or_default())
}

#[tauri::command]
pub fn logs_clear() -> Result<LogClearResult, String> {
    runtime_store()?.clear()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_entry(
        id: &str,
        tags: &[&str],
        timestamp_ms: i64,
        level: LogLevel,
        source: LogSource,
    ) -> LogEntry {
        LogEntry {
            id: id.to_string(),
            timestamp: current_timestamp_string(),
            timestamp_ms,
            level,
            source,
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            event: "test.event".to_string(),
            message: "hello".to_string(),
            trace_id: Some("trace-1".to_string()),
            correlation_id: Some("corr-1".to_string()),
            parent_id: Some("parent-1".to_string()),
            depth: 2,
            kind: LogKind::Event,
            expandable: false,
            duration_ms: Some(10),
            data: Some(json!({ "ok": true })),
        }
    }

    #[test]
    fn new_store_sets_expected_paths() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        assert_eq!(
            store.active_path(),
            temp.path().join("logs").join("rakh.log")
        );
    }

    #[test]
    fn append_entry_writes_jsonl() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        store
            .append_entry(sample_entry(
                "entry-1",
                &["backend", "tool-calls"],
                1,
                LogLevel::Info,
                LogSource::Backend,
            ))
            .expect("append entry");

        let content = fs::read_to_string(store.active_path()).expect("read active log");
        let line = content.lines().next().expect("line");
        let parsed: LogEntry = serde_json::from_str(line).expect("parse");
        assert_eq!(parsed.id, "entry-1");
        assert_eq!(parsed.tags, vec!["backend", "tool-calls"]);
    }

    #[test]
    fn rotation_keeps_archive_count() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        fs::write(
            store.active_path(),
            "x".repeat((LOG_ROTATE_BYTES + 1) as usize),
        )
        .expect("write");
        for index in 1..=LOG_ARCHIVE_COUNT {
            fs::write(store.archived_path(index), format!("archive-{index}")).expect("archive");
        }

        store
            .append_entry(sample_entry(
                "entry-2",
                &["backend"],
                2,
                LogLevel::Info,
                LogSource::Backend,
            ))
            .expect("append");

        assert!(store.archived_path(1).exists());
        assert!(store.archived_path(LOG_ARCHIVE_COUNT).exists());
        let archived = fs::read_to_string(store.archived_path(1)).expect("read archive");
        assert!(archived.contains('x'));
    }

    #[test]
    fn clear_removes_active_and_archives() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        fs::write(store.active_path(), "active").expect("write active");
        fs::write(store.archived_path(1), "archive").expect("write archive");

        let result = store.clear().expect("clear");

        assert_eq!(result.removed_files, 2);
        assert!(!store.active_path().exists());
        assert!(!store.archived_path(1).exists());
    }

    #[test]
    fn query_supports_and_or_tag_filters() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        store
            .append_entry(sample_entry(
                "entry-1",
                &["backend", "db"],
                10,
                LogLevel::Info,
                LogSource::Backend,
            ))
            .expect("append 1");
        store
            .append_entry(sample_entry(
                "entry-2",
                &["frontend", "system"],
                20,
                LogLevel::Warn,
                LogSource::Frontend,
            ))
            .expect("append 2");

        let or_filtered = store
            .query(LogQueryFilter {
                tags: Some(vec!["db".to_string(), "system".to_string()]),
                tag_mode: Some(TagMode::Or),
                ..LogQueryFilter::default()
            })
            .expect("or query");
        assert_eq!(or_filtered.len(), 2);

        let and_filtered = store
            .query(LogQueryFilter {
                tags: Some(vec!["backend".to_string(), "db".to_string()]),
                tag_mode: Some(TagMode::And),
                ..LogQueryFilter::default()
            })
            .expect("and query");
        assert_eq!(and_filtered.len(), 1);
        assert_eq!(and_filtered[0].id, "entry-1");
    }

    #[test]
    fn query_filters_level_source_and_ids() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        store
            .append_entry(sample_entry(
                "entry-1",
                &["backend"],
                10,
                LogLevel::Info,
                LogSource::Backend,
            ))
            .expect("append 1");
        store
            .append_entry(sample_entry(
                "entry-2",
                &["frontend"],
                20,
                LogLevel::Warn,
                LogSource::Frontend,
            ))
            .expect("append 2");

        let filtered = store
            .query(LogQueryFilter {
                levels: Some(vec![LogLevel::Warn]),
                source: Some(LogSource::Frontend),
                trace_id: Some("trace-1".to_string()),
                correlation_id: Some("corr-1".to_string()),
                since_ms: Some(15),
                until_ms: Some(25),
                ..LogQueryFilter::default()
            })
            .expect("filtered query");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "entry-2");
        assert_eq!(filtered[0].depth, 2);
        assert_eq!(filtered[0].parent_id.as_deref(), Some("parent-1"));
    }

    #[test]
    fn export_writes_filtered_jsonl_file() {
        let temp = tempdir().expect("tempdir");
        let store = LogStore::new(temp.path().join("logs")).expect("store");
        store
            .append_entry(sample_entry(
                "entry-1",
                &["backend", "db"],
                10,
                LogLevel::Info,
                LogSource::Backend,
            ))
            .expect("append");

        let exported = store
            .export(LogQueryFilter {
                tags: Some(vec!["db".to_string()]),
                ..LogQueryFilter::default()
            })
            .expect("export");

        assert_eq!(exported.count, 1);
        let exported_content = fs::read_to_string(exported.path).expect("read export");
        assert!(exported_content.contains("\"id\":\"entry-1\""));
    }

    #[test]
    fn build_backend_entry_carries_trace_fields() {
        let context = LogContext {
            trace_id: Some("trace-main".to_string()),
            correlation_id: Some("tool-1".to_string()),
            parent_id: Some("tool:tool-1:start".to_string()),
            depth: Some(3),
            ..LogContext::default()
        };

        let entry = build_backend_entry(
            "exec_run",
            "ok",
            json!({
                "durationMs": 42,
                "exitCode": 0
            }),
            Some(&context),
        );

        assert_eq!(entry.trace_id.as_deref(), Some("trace-main"));
        assert_eq!(entry.correlation_id.as_deref(), Some("tool-1"));
        assert_eq!(entry.parent_id.as_deref(), Some("tool:tool-1:start"));
        assert_eq!(entry.depth, 3);
        assert_eq!(entry.duration_ms, Some(42));
        assert_eq!(entry.kind, LogKind::End);
    }
}
