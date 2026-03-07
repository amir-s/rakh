#[cfg(not(test))]
use crate::shell_env::{login_shell_candidates, run_login_shell_script};
use crate::utils::{app_store_root, non_empty_env_var, now_ms, tool_log};
use portable_pty::MasterPty;
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::State;
use uuid::Uuid;

/* ── PersistedSession ─────────────────────────────────────────────────────── */

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub id: String,
    pub label: String,
    pub icon: String,
    pub mode: String,
    pub tab_title: String,
    pub cwd: String,
    pub model: String,
    pub plan_markdown: String,
    pub plan_version: i64,
    pub plan_updated_at: i64,
    /// JSON-serialised ChatMessage[]
    pub chat_messages: String,
    /// JSON-serialised ApiMessage[]
    pub api_messages: String,
    /// JSON-serialised TodoItem[]
    pub todos: String,
    /// JSON-serialised ReviewEdit[]
    pub review_edits: String,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Absolute path to the git worktree for this session (empty = none)
    pub worktree_path: String,
    /// Git branch name for the worktree (empty = none)
    pub worktree_branch: String,
    /// Whether the user declined worktree creation
    pub worktree_declined: bool,
    /// Whether debug-only UI is enabled for this session
    pub show_debug: bool,
    /// JSON-serialised AdvancedModelOptions (empty string / '{}' = use defaults)
    pub advanced_options: String,
}

/* ── Artifact models ─────────────────────────────────────────────────────── */

const MAX_ARTIFACT_CONTENT_BYTES: usize = 1_000_000;
// Keep in sync with ARTIFACT_CONTENT_FORMAT in src/agent/tools/artifacts.ts.
const ARTIFACT_CONTENT_FORMAT_VALUES: [&str; 4] = ["text", "markdown", "unified-diff", "json"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub version: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactManifest {
    pub session_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub artifact_seq: i64,
    pub artifact_id: String,
    pub version: i64,
    pub kind: String,
    pub summary: String,
    /// Parent artifact this was derived from (previous version or source artifact).
    pub parent: Option<ArtifactRef>,
    pub metadata: Value,
    pub content_format: String,
    pub blob_hash: String,
    pub size_bytes: i64,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCreateInput {
    pub kind: String,
    pub summary: Option<String>,
    pub parent: Option<ArtifactRef>,
    pub content_format: String,
    pub content: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionInput {
    pub artifact_id: String,
    pub summary: Option<String>,
    pub parent: Option<ArtifactRef>,
    pub content_format: Option<String>,
    pub content: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListInput {
    pub run_id: Option<String>,
    pub agent_id: Option<String>,
    pub kind: Option<String>,
    pub latest_only: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
struct ArtifactManifestRow {
    session_id: String,
    run_id: String,
    agent_id: String,
    artifact_seq: i64,
    artifact_id: String,
    version: i64,
    kind: String,
    summary: String,
    parent_json: String,
    metadata_json: String,
    content_format: String,
    blob_hash: String,
    size_bytes: i64,
    created_at: i64,
}

fn parse_manifest_row(row: &Row<'_>) -> rusqlite::Result<ArtifactManifestRow> {
    Ok(ArtifactManifestRow {
        session_id: row.get(0)?,
        run_id: row.get(1)?,
        agent_id: row.get(2)?,
        artifact_seq: row.get(3)?,
        artifact_id: row.get(4)?,
        version: row.get(5)?,
        kind: row.get(6)?,
        summary: row.get(7)?,
        parent_json: row.get(8)?,
        metadata_json: row.get(9)?,
        content_format: row.get(10)?,
        blob_hash: row.get(11)?,
        size_bytes: row.get(12)?,
        created_at: row.get(13)?,
    })
}

fn parse_json_or_default<T>(raw: &str, fallback: T) -> T
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn to_json_string<T: Serialize>(value: &T, field_name: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| {
        format!(
            "INVALID_ARGUMENT: failed to serialize {}: {}",
            field_name, e
        )
    })
}

fn validate_non_empty(value: &str, field_name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!(
            "INVALID_ARGUMENT: {} must not be empty",
            field_name
        ));
    }
    Ok(())
}

fn validate_content_format(value: &str) -> Result<(), String> {
    if ARTIFACT_CONTENT_FORMAT_VALUES.contains(&value) {
        return Ok(());
    }
    Err(format!(
        "INVALID_ARGUMENT: contentFormat must be one of {}",
        ARTIFACT_CONTENT_FORMAT_VALUES.join(", ")
    ))
}

fn validate_content_size(content: &str) -> Result<(), String> {
    let bytes = content.as_bytes().len();
    if bytes > MAX_ARTIFACT_CONTENT_BYTES {
        return Err(format!(
            "TOO_LARGE: content exceeds {} bytes",
            MAX_ARTIFACT_CONTENT_BYTES
        ));
    }
    Ok(())
}

fn normalize_artifact_kind_prefix(kind: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;

    for ch in kind.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }

    let out = out.trim_matches('_');
    if out.is_empty() {
        "artifact".to_string()
    } else {
        out.to_string()
    }
}

fn new_short_artifact_id(kind: &str) -> String {
    let prefix = normalize_artifact_kind_prefix(kind);
    let hex = Uuid::new_v4().simple().to_string();
    let short = hex.get(0..8).unwrap_or(&hex);
    format!("{}_{}", prefix, short)
}

fn is_retryable_artifact_id_collision(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(sqlite_err, _) => {
            // Only retry on PRIMARY KEY (1555) or UNIQUE constraint (2067) violations.
            // Checking the extended code avoids retrying on unrelated SQLITE_CONSTRAINT
            // errors like CHECK or FOREIGN KEY failures (also primary code 19).
            sqlite_err.extended_code == 1555 || sqlite_err.extended_code == 2067
        }
        _ => false,
    }
}

fn artifact_blob_root() -> Result<PathBuf, String> {
    Ok(app_store_root()?
        .join("artifacts")
        .join("blobs")
        .join("sha256"))
}

fn ensure_artifact_blob_root() -> Result<PathBuf, String> {
    let root = artifact_blob_root()?;
    fs::create_dir_all(&root).map_err(|e| format!("Cannot create artifact blob root: {}", e))?;
    Ok(root)
}

fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest)
}

fn blob_rel_path(hash: &str) -> String {
    let prefix_a = hash.get(0..2).unwrap_or("xx");
    let prefix_b = hash.get(2..4).unwrap_or("xx");
    format!("{}/{}/{}.blob", prefix_a, prefix_b, hash)
}

fn read_blob_content(hash: &str, rel_path: &str) -> Result<String, String> {
    let root = ensure_artifact_blob_root()?;
    let path = root.join(rel_path);
    if !path.exists() {
        return Err(format!(
            "NOT_FOUND: missing blob file for hash {} at {}",
            hash,
            path.display()
        ));
    }

    let mut file = fs::File::open(&path)
        .map_err(|e| format!("INTERNAL: cannot open blob {}: {}", path.display(), e))?;
    let mut bytes = Vec::<u8>::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("INTERNAL: cannot read blob {}: {}", path.display(), e))?;
    String::from_utf8(bytes)
        .map_err(|e| format!("INTERNAL: blob {} is not valid utf8: {}", path.display(), e))
}

fn write_blob_if_missing(rel_path: &str, content: &str) -> Result<(), String> {
    let root = ensure_artifact_blob_root()?;
    let final_path = root.join(rel_path);
    if final_path.exists() {
        return Ok(());
    }
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "INTERNAL: cannot create blob dir {}: {}",
                parent.display(),
                e
            )
        })?;
    }

    let tmp_path = final_path.with_extension(format!("blob.tmp-{}", now_ms()));
    fs::write(&tmp_path, content.as_bytes()).map_err(|e| {
        format!(
            "INTERNAL: cannot write blob temp {}: {}",
            tmp_path.display(),
            e
        )
    })?;
    match fs::rename(&tmp_path, &final_path) {
        Ok(()) => Ok(()),
        Err(e) => {
            if final_path.exists() {
                let _ = fs::remove_file(&tmp_path);
                Ok(())
            } else {
                Err(format!(
                    "INTERNAL: cannot move blob {} to {}: {}",
                    tmp_path.display(),
                    final_path.display(),
                    e
                ))
            }
        }
    }
}

fn upsert_blob_record(
    db: &Connection,
    content: &str,
    content_format: &str,
) -> Result<(String, i64), String> {
    validate_content_size(content)?;
    let hash = hash_content(content);
    let rel_path = blob_rel_path(&hash);
    let size_bytes = content.as_bytes().len() as i64;
    write_blob_if_missing(&rel_path, content)?;

    db.execute(
        "INSERT OR IGNORE INTO artifact_blobs (
            hash, storage_rel_path, content_format, size_bytes, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![hash, rel_path, content_format, size_bytes, now_ms()],
    )
    .map_err(|e| format!("INTERNAL: failed to upsert blob row: {}", e))?;

    Ok((hash, size_bytes))
}

fn gc_orphaned_artifact_blobs(db: &Connection) -> Result<usize, String> {
    // Collect orphaned rows up front so the statement is dropped before we
    // modify the table (avoids iterator-over-mutated-table issues).
    let orphans: Vec<(String, String)> = {
        let mut stmt = db
            .prepare(
                "SELECT b.hash, b.storage_rel_path
                 FROM artifact_blobs b
                 LEFT JOIN artifact_manifests m ON m.blob_hash = b.hash
                 WHERE m.blob_hash IS NULL",
            )
            .map_err(|e| format!("INTERNAL: failed to prepare orphan blob query: {}", e))?;
        let collected = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("INTERNAL: failed to read orphan blob rows: {}", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("INTERNAL: failed to collect orphan blob rows: {}", e))?;
        collected
    };

    if orphans.is_empty() {
        return Ok(0);
    }

    let root = ensure_artifact_blob_root()?;

    // Delete DB rows first: if we crash before file removal completes, orphan
    // files linger on disk but no phantom DB rows remain pointing to missing blobs.
    for (hash, _) in &orphans {
        db.execute("DELETE FROM artifact_blobs WHERE hash = ?1", params![hash])
            .map_err(|e| format!("INTERNAL: failed to delete blob metadata: {}", e))?;
    }

    // Best-effort file removal; a missing file is harmless.
    for (_, rel_path) in &orphans {
        let path = root.join(rel_path);
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }

    Ok(orphans.len())
}

fn manifest_row_to_api(
    row: ArtifactManifestRow,
    include_content: bool,
) -> Result<ArtifactManifest, String> {
    let parent = parse_json_or_default::<Option<ArtifactRef>>(&row.parent_json, None);
    let metadata = parse_json_or_default::<Value>(&row.metadata_json, json!({}));
    let content = if include_content {
        let rel_path = blob_rel_path(&row.blob_hash);
        Some(read_blob_content(&row.blob_hash, &rel_path)?)
    } else {
        None
    };

    Ok(ArtifactManifest {
        session_id: row.session_id,
        run_id: row.run_id,
        agent_id: row.agent_id,
        artifact_seq: row.artifact_seq,
        artifact_id: row.artifact_id,
        version: row.version,
        kind: row.kind,
        summary: row.summary,
        parent,
        metadata,
        content_format: row.content_format,
        blob_hash: row.blob_hash,
        size_bytes: row.size_bytes,
        created_at: row.created_at,
        content,
    })
}

fn load_latest_manifest_row(
    db: &Connection,
    session_id: &str,
    artifact_id: &str,
) -> Result<Option<ArtifactManifestRow>, String> {
    let mut stmt = db
        .prepare(
            "SELECT
                session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                kind, summary, parent_json,
                metadata_json, content_format, blob_hash, size_bytes, created_at
             FROM artifact_manifests
             WHERE session_id = ?1 AND artifact_id = ?2
             ORDER BY version DESC
             LIMIT 1",
        )
        .map_err(|e| format!("INTERNAL: failed to prepare artifact latest query: {}", e))?;

    stmt.query_row(params![session_id, artifact_id], |row| {
        parse_manifest_row(row)
    })
    .optional()
    .map_err(|e| format!("INTERNAL: failed to query latest artifact row: {}", e))
}

/* ── AppState ─────────────────────────────────────────────────────────────── */

pub struct AppState {
    pub pty_writers: Mutex<HashMap<String, Arc<Mutex<Box<dyn Write + Send>>>>>,
    pub pty_masters: Mutex<HashMap<String, Arc<Mutex<Box<dyn MasterPty + Send>>>>>,
    pub db: Mutex<Connection>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProviderEnvApiKeys {
    openai_api_key: Option<String>,
    anthropic_auth_token: Option<String>,
    anthropic_api_key: Option<String>,
}

impl ProviderEnvApiKeys {
    fn from_process_env() -> Self {
        Self {
            openai_api_key: non_empty_env_var("OPENAI_API_KEY"),
            anthropic_auth_token: non_empty_env_var("ANTHROPIC_AUTH_TOKEN"),
            anthropic_api_key: non_empty_env_var("ANTHROPIC_API_KEY"),
        }
    }

    fn merge_missing_from(&mut self, fallback: Self) {
        if self.openai_api_key.is_none() {
            self.openai_api_key = fallback.openai_api_key;
        }
        if self.anthropic_auth_token.is_none() {
            self.anthropic_auth_token = fallback.anthropic_auth_token;
        }
        if self.anthropic_api_key.is_none() {
            self.anthropic_api_key = fallback.anthropic_api_key;
        }
    }

    #[cfg(not(test))]
    fn has_anthropic_key(&self) -> bool {
        self.anthropic_auth_token.is_some() || self.anthropic_api_key.is_some()
    }

    #[cfg(not(test))]
    fn needs_shell_fallback(&self) -> bool {
        self.openai_api_key.is_none() || !self.has_anthropic_key()
    }

    fn preferred_anthropic_key(&self) -> Option<String> {
        self.anthropic_auth_token
            .clone()
            .or_else(|| self.anthropic_api_key.clone())
    }

    fn has_any_key(&self) -> bool {
        self.openai_api_key.is_some()
            || self.anthropic_auth_token.is_some()
            || self.anthropic_api_key.is_some()
    }
}

fn normalized_env_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_login_shell_probe_output(stdout: &str) -> ProviderEnvApiKeys {
    const OPENAI_PREFIX: &str = "__RAKH_OPENAI_API_KEY__";
    const ANTHROPIC_AUTH_PREFIX: &str = "__RAKH_ANTHROPIC_AUTH_TOKEN__";
    const ANTHROPIC_PREFIX: &str = "__RAKH_ANTHROPIC_API_KEY__";

    let mut keys = ProviderEnvApiKeys::default();
    for line in stdout.lines() {
        if let Some(raw) = line.strip_prefix(OPENAI_PREFIX) {
            keys.openai_api_key = normalized_env_value(raw);
            continue;
        }
        if let Some(raw) = line.strip_prefix(ANTHROPIC_AUTH_PREFIX) {
            keys.anthropic_auth_token = normalized_env_value(raw);
            continue;
        }
        if let Some(raw) = line.strip_prefix(ANTHROPIC_PREFIX) {
            keys.anthropic_api_key = normalized_env_value(raw);
        }
    }

    keys
}

#[cfg(not(test))]
fn run_login_shell_probe(shell_path: &str) -> Option<ProviderEnvApiKeys> {
    let shell_name = std::path::Path::new(shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    let script = if shell_name == "fish" {
        "printf '__RAKH_OPENAI_API_KEY__%s\\n' \"$OPENAI_API_KEY\"; \
         printf '__RAKH_ANTHROPIC_AUTH_TOKEN__%s\\n' \"$ANTHROPIC_AUTH_TOKEN\"; \
         printf '__RAKH_ANTHROPIC_API_KEY__%s\\n' \"$ANTHROPIC_API_KEY\""
    } else {
        "printf '__RAKH_OPENAI_API_KEY__%s\\n' \"${OPENAI_API_KEY-}\"; \
         printf '__RAKH_ANTHROPIC_AUTH_TOKEN__%s\\n' \"${ANTHROPIC_AUTH_TOKEN-}\"; \
         printf '__RAKH_ANTHROPIC_API_KEY__%s\\n' \"${ANTHROPIC_API_KEY-}\""
    };

    let stdout = run_login_shell_script(shell_path, script)?;
    Some(parse_login_shell_probe_output(&stdout))
}

#[cfg(not(test))]
fn read_provider_env_api_keys_from_login_shell() -> ProviderEnvApiKeys {
    for shell in login_shell_candidates() {
        if let Some(keys) = run_login_shell_probe(&shell) {
            if keys.has_any_key() {
                return keys;
            }
        }
    }

    ProviderEnvApiKeys::default()
}

#[cfg(test)]
fn resolve_provider_env_api_keys() -> (ProviderEnvApiKeys, bool) {
    let resolved = ProviderEnvApiKeys::from_process_env();
    (resolved, false)
}

#[cfg(not(test))]
fn resolve_provider_env_api_keys() -> (ProviderEnvApiKeys, bool) {
    let mut resolved = ProviderEnvApiKeys::from_process_env();
    if !resolved.needs_shell_fallback() {
        return (resolved, false);
    }

    let before_merge = resolved.clone();
    let fallback = read_provider_env_api_keys_from_login_shell();
    resolved.merge_missing_from(fallback);
    let used_shell_fallback = resolved != before_merge;
    (resolved, used_shell_fallback)
}

/* ── init_db ─────────────────────────────────────────────────────────────── */

pub fn init_db() -> Result<Connection, String> {
    let sessions_dir = app_store_root()?.join("sessions");
    fs::create_dir_all(&sessions_dir).map_err(|e| {
        format!(
            "Cannot create sessions directory {}: {}",
            sessions_dir.display(),
            e
        )
    })?;
    let db_path = sessions_dir.join("sessions.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Cannot open {}: {}", db_path.display(), e))?;
    // Enable WAL mode for better concurrent read performance
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("PRAGMA failed: {}", e))?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sessions (
            id               TEXT    PRIMARY KEY,
            label            TEXT    NOT NULL,
            icon             TEXT    NOT NULL,
            mode             TEXT    NOT NULL,
            tab_title        TEXT    NOT NULL DEFAULT '',
            cwd              TEXT    NOT NULL DEFAULT '',
            model            TEXT    NOT NULL DEFAULT '',
            plan_markdown    TEXT    NOT NULL DEFAULT '',
            plan_version     INTEGER NOT NULL DEFAULT 0,
            plan_updated_at  INTEGER NOT NULL DEFAULT 0,
            chat_messages    TEXT    NOT NULL DEFAULT '[]',
            api_messages     TEXT    NOT NULL DEFAULT '[]',
            todos            TEXT    NOT NULL DEFAULT '[]',
            archived         INTEGER NOT NULL DEFAULT 0,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER NOT NULL,
            show_debug          INTEGER NOT NULL DEFAULT 0,
            advanced_options    TEXT    NOT NULL DEFAULT '{}'
        );
    ",
    )
    .map_err(|e| format!("Schema migration failed: {}", e))?;
    // Additive migrations — safe to run on both new and existing databases.
    let _ = conn
        .execute_batch("ALTER TABLE sessions ADD COLUMN review_edits TEXT NOT NULL DEFAULT '[]';");
    let _ = conn
        .execute_batch("ALTER TABLE sessions ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';");
    let _ = conn
        .execute_batch("ALTER TABLE sessions ADD COLUMN worktree_branch TEXT NOT NULL DEFAULT '';");
    let _ = conn.execute_batch(
        "ALTER TABLE sessions ADD COLUMN worktree_declined INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn
        .execute_batch("ALTER TABLE sessions ADD COLUMN show_debug INTEGER NOT NULL DEFAULT 0;");
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS artifact_blobs (
            hash             TEXT    PRIMARY KEY,
            storage_rel_path TEXT    NOT NULL,
            content_format   TEXT    NOT NULL,
            size_bytes       INTEGER NOT NULL,
            created_at       INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS artifact_manifests (
            session_id     TEXT    NOT NULL,
            run_id         TEXT    NOT NULL,
            agent_id       TEXT    NOT NULL,
            artifact_seq   INTEGER NOT NULL,
            artifact_id    TEXT    NOT NULL,
            version        INTEGER NOT NULL,
            kind           TEXT    NOT NULL,
            summary        TEXT    NOT NULL DEFAULT '',
            parent_json    TEXT    NOT NULL DEFAULT 'null',
            metadata_json  TEXT    NOT NULL DEFAULT '{}',
            content_format TEXT    NOT NULL,
            blob_hash      TEXT    NOT NULL,
            size_bytes     INTEGER NOT NULL,
            created_at     INTEGER NOT NULL,
            PRIMARY KEY (session_id, artifact_id, version)
        );

        CREATE INDEX IF NOT EXISTS idx_artifact_manifests_session_created
          ON artifact_manifests(session_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_artifact_manifests_run_agent
          ON artifact_manifests(session_id, run_id, agent_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_artifact_manifests_kind
          ON artifact_manifests(session_id, kind);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_manifests_seq_v1
          ON artifact_manifests(session_id, run_id, agent_id, artifact_seq)
          WHERE version = 1;
    ",
    )
    .map_err(|e| format!("Artifact schema migration failed: {}", e))?;
    Ok(conn)
}

/* ── Tauri commands ──────────────────────────────────────────────────────── */

#[tauri::command]
pub fn load_provider_env_api_keys() -> Result<Value, String> {
    let start = Instant::now();
    tool_log("load_provider_env_api_keys", "start", json!({}));

    let (resolved_keys, used_shell_fallback) = resolve_provider_env_api_keys();
    let result = Ok(json!({
        "openaiApiKey": resolved_keys.openai_api_key,
        "anthropicApiKey": resolved_keys.preferred_anthropic_key(),
    }));

    tool_log(
        "load_provider_env_api_keys",
        "ok",
        json!({
            "durationMs": start.elapsed().as_millis() as u64,
            "usedShellFallback": used_shell_fallback,
            "openaiApiKeyPresent": result.as_ref().ok().and_then(|v| v["openaiApiKey"].as_str()).is_some(),
            "anthropicApiKeyPresent": result.as_ref().ok().and_then(|v| v["anthropicApiKey"].as_str()).is_some(),
        }),
    );

    result
}

#[tauri::command]
pub fn db_load_sessions(state: State<'_, AppState>) -> Result<Vec<PersistedSession>, String> {
    let start = Instant::now();
    tool_log("db_load_sessions", "start", json!({}));

    let result: Result<Vec<PersistedSession>, String> = (|| {
        let db = state.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id, label, icon, mode, tab_title, cwd, model,
                plan_markdown, plan_version, plan_updated_at,
                chat_messages, api_messages, todos, review_edits,
                archived, created_at, updated_at,
                worktree_path, worktree_branch, worktree_declined, show_debug,
                advanced_options
         FROM sessions
         WHERE archived = 0
         ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(PersistedSession {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    icon: row.get(2)?,
                    mode: row.get(3)?,
                    tab_title: row.get(4)?,
                    cwd: row.get(5)?,
                    model: row.get(6)?,
                    plan_markdown: row.get(7)?,
                    plan_version: row.get(8)?,
                    plan_updated_at: row.get(9)?,
                    chat_messages: row.get(10)?,
                    api_messages: row.get(11)?,
                    todos: row.get(12)?,
                    review_edits: row.get(13)?,
                    archived: row.get::<_, i64>(14)? != 0,
                    created_at: row.get(15)?,
                    updated_at: row.get(16)?,
                    worktree_path: row.get(17)?,
                    worktree_branch: row.get(18)?,
                    worktree_declined: row.get::<_, i64>(19)? != 0,
                    show_debug: row.get::<_, i64>(20)? != 0,
                    advanced_options: row.get::<_, String>(21).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;

        sessions
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })();

    match &result {
        Ok(s) => tool_log(
            "db_load_sessions",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "count": s.len()
            }),
        ),
        Err(e) => tool_log(
            "db_load_sessions",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_upsert_session(
    session: PersistedSession,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let start = Instant::now();
    tool_log(
        "db_upsert_session",
        "start",
        json!({
            "id": session.id,
            "archived": session.archived,
            "hasWorktree": !session.worktree_path.is_empty()
        }),
    );

    let result: Result<(), String> = (|| {
        let db = state.db.lock().unwrap();
        let now = now_ms();
        db.execute(
            "INSERT INTO sessions (
            id, label, icon, mode, tab_title, cwd, model,
            plan_markdown, plan_version, plan_updated_at,
            chat_messages, api_messages, todos, review_edits,
            archived, created_at, updated_at,
            worktree_path, worktree_branch, worktree_declined, show_debug, advanced_options
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
         ON CONFLICT(id) DO UPDATE SET
            label             = excluded.label,
            icon              = excluded.icon,
            mode              = excluded.mode,
            tab_title         = excluded.tab_title,
            cwd               = excluded.cwd,
            model             = excluded.model,
            plan_markdown     = excluded.plan_markdown,
            plan_version      = excluded.plan_version,
            plan_updated_at   = excluded.plan_updated_at,
            chat_messages     = excluded.chat_messages,
            api_messages      = excluded.api_messages,
            todos             = excluded.todos,
            review_edits      = excluded.review_edits,
            archived          = excluded.archived,
            worktree_path     = excluded.worktree_path,
            worktree_branch   = excluded.worktree_branch,
            worktree_declined = excluded.worktree_declined,
            show_debug        = excluded.show_debug,
            advanced_options  = excluded.advanced_options,
            updated_at        = ?17",
            rusqlite::params![
                session.id,
                session.label,
                session.icon,
                session.mode,
                session.tab_title,
                session.cwd,
                session.model,
                session.plan_markdown,
                session.plan_version,
                session.plan_updated_at,
                session.chat_messages,
                session.api_messages,
                session.todos,
                session.review_edits,
                session.archived as i64,
                session.created_at,
                now,
                session.worktree_path,
                session.worktree_branch,
                session.worktree_declined as i64,
                session.show_debug as i64,
                session.advanced_options,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();

    match &result {
        Ok(()) => tool_log(
            "db_upsert_session",
            "ok",
            json!({ "durationMs": start.elapsed().as_millis() as u64 }),
        ),
        Err(e) => tool_log(
            "db_upsert_session",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_archive_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let start = Instant::now();
    tool_log("db_archive_session", "start", json!({ "id": id }));

    let result: Result<(), String> = (|| {
        let db = state.db.lock().unwrap();
        let now = now_ms();
        db.execute(
            "UPDATE sessions SET archived = 1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();

    match &result {
        Ok(()) => tool_log(
            "db_archive_session",
            "ok",
            json!({ "durationMs": start.elapsed().as_millis() as u64 }),
        ),
        Err(e) => tool_log(
            "db_archive_session",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_load_archived_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<PersistedSession>, String> {
    let start = Instant::now();
    tool_log("db_load_archived_sessions", "start", json!({}));

    let result: Result<Vec<PersistedSession>, String> = (|| {
        let db = state.db.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT id, label, icon, mode, tab_title, cwd, model,
                plan_markdown, plan_version, plan_updated_at,
                chat_messages, api_messages, todos, review_edits,
                archived, created_at, updated_at,
                worktree_path, worktree_branch, worktree_declined, show_debug,
                advanced_options
         FROM sessions
         WHERE archived = 1
         ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let sessions = stmt
            .query_map([], |row| {
                Ok(PersistedSession {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    icon: row.get(2)?,
                    mode: row.get(3)?,
                    tab_title: row.get(4)?,
                    cwd: row.get(5)?,
                    model: row.get(6)?,
                    plan_markdown: row.get(7)?,
                    plan_version: row.get(8)?,
                    plan_updated_at: row.get(9)?,
                    chat_messages: row.get(10)?,
                    api_messages: row.get(11)?,
                    todos: row.get(12)?,
                    review_edits: row.get(13)?,
                    archived: row.get::<_, i64>(14)? != 0,
                    created_at: row.get(15)?,
                    updated_at: row.get(16)?,
                    worktree_path: row.get(17)?,
                    worktree_branch: row.get(18)?,
                    worktree_declined: row.get::<_, i64>(19)? != 0,
                    show_debug: row.get::<_, i64>(20)? != 0,
                    advanced_options: row.get::<_, String>(21).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;

        sessions
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })();

    match &result {
        Ok(s) => tool_log(
            "db_load_archived_sessions",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "count": s.len()
            }),
        ),
        Err(e) => tool_log(
            "db_load_archived_sessions",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_artifact_create(
    session_id: String,
    run_id: String,
    agent_id: String,
    input: ArtifactCreateInput,
    state: State<'_, AppState>,
) -> Result<ArtifactManifest, String> {
    let start = Instant::now();
    tool_log(
        "db_artifact_create",
        "start",
        json!({
            "sessionId": session_id,
            "runId": run_id,
            "agentId": agent_id,
            "kind": input.kind,
            "contentFormat": input.content_format
        }),
    );

    let result: Result<ArtifactManifest, String> = (|| {
        validate_non_empty(&session_id, "sessionId")?;
        validate_non_empty(&run_id, "runId")?;
        validate_non_empty(&agent_id, "agentId")?;
        validate_non_empty(&input.kind, "kind")?;
        validate_content_format(&input.content_format)?;
        validate_content_size(&input.content)?;

        let db = state.db.lock().unwrap();
        let (blob_hash, size_bytes) =
            upsert_blob_record(&db, &input.content, &input.content_format)?;

        let next_seq: i64 = db
            .query_row(
                "SELECT COALESCE(MAX(artifact_seq), 0) + 1
                 FROM artifact_manifests
                 WHERE session_id = ?1 AND run_id = ?2 AND agent_id = ?3",
                params![&session_id, &run_id, &agent_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("INTERNAL: failed to allocate artifact sequence: {}", e))?;

        let created_at = now_ms();
        let summary = input.summary.unwrap_or_default();
        let metadata = input.metadata.unwrap_or_else(|| json!({}));

        let parent_json = to_json_string(&input.parent, "parent")?;
        let metadata_json = to_json_string(&metadata, "metadata")?;

        // Short, kind-prefixed, stable ID (versioning appends by version number).
        // Example: plan_3f8a2c91, patch_a1b2c3d4
        let max_attempts = 8usize;
        for _ in 0..max_attempts {
            let artifact_id = new_short_artifact_id(&input.kind);

            let inserted = db.execute(
                "INSERT INTO artifact_manifests (
                    session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                    kind, summary, parent_json, metadata_json, content_format,
                    blob_hash, size_bytes, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    &session_id,
                    &run_id,
                    &agent_id,
                    next_seq,
                    &artifact_id,
                    input.kind,
                    summary,
                    parent_json,
                    metadata_json,
                    input.content_format,
                    blob_hash,
                    size_bytes,
                    created_at
                ],
            );

            match inserted {
                Ok(_) => {
                    let row = load_latest_manifest_row(&db, &session_id, &artifact_id)?
                        .ok_or_else(|| "INTERNAL: failed to load inserted artifact".to_string())?;
                    return manifest_row_to_api(row, false);
                }
                Err(e) => {
                    if is_retryable_artifact_id_collision(&e) {
                        continue;
                    }
                    return Err(format!(
                        "INTERNAL: failed to insert artifact manifest: {}",
                        e
                    ));
                }
            }
        }

        Err(format!(
            "CONFLICT: failed to allocate unique artifactId after {} attempts",
            max_attempts
        ))
    })();

    match &result {
        Ok(v) => tool_log(
            "db_artifact_create",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": v.artifact_id,
                "version": v.version,
                "blobHash": v.blob_hash
            }),
        ),
        Err(e) => tool_log(
            "db_artifact_create",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_artifact_version(
    session_id: String,
    run_id: String,
    agent_id: String,
    input: ArtifactVersionInput,
    state: State<'_, AppState>,
) -> Result<ArtifactManifest, String> {
    let start = Instant::now();
    tool_log(
        "db_artifact_version",
        "start",
        json!({
            "sessionId": session_id,
            "runId": run_id,
            "agentId": agent_id,
            "artifactId": input.artifact_id
        }),
    );

    let result: Result<ArtifactManifest, String> = (|| {
        validate_non_empty(&session_id, "sessionId")?;
        validate_non_empty(&run_id, "runId")?;
        validate_non_empty(&agent_id, "agentId")?;
        validate_non_empty(&input.artifact_id, "artifactId")?;

        let db = state.db.lock().unwrap();
        let latest = load_latest_manifest_row(&db, &session_id, &input.artifact_id)?
            .ok_or_else(|| format!("NOT_FOUND: artifact {} not found", input.artifact_id))?;

        let latest_parent = parse_json_or_default::<Option<ArtifactRef>>(&latest.parent_json, None);
        let latest_metadata = parse_json_or_default::<Value>(&latest.metadata_json, json!({}));

        // If caller doesn't supply a new parent, carry forward the existing one.
        let parent = if input.parent.is_some() {
            input.parent
        } else {
            latest_parent
        };

        let summary = input.summary.unwrap_or_else(|| latest.summary.clone());
        let metadata = input.metadata.unwrap_or(latest_metadata);

        let (content_format, blob_hash, size_bytes) = if let Some(content) = input.content {
            let next_format = input
                .content_format
                .unwrap_or_else(|| latest.content_format.clone());
            validate_content_format(&next_format)?;
            let (hash, size) = upsert_blob_record(&db, &content, &next_format)?;
            (next_format, hash, size)
        } else {
            if input.content_format.is_some() {
                return Err(
                    "INVALID_ARGUMENT: contentFormat cannot be set when content is omitted"
                        .to_string(),
                );
            }
            (
                latest.content_format.clone(),
                latest.blob_hash.clone(),
                latest.size_bytes,
            )
        };

        let parent_json = to_json_string(&parent, "parent")?;
        let metadata_json = to_json_string(&metadata, "metadata")?;

        let next_version = latest.version + 1;
        db.execute(
            "INSERT INTO artifact_manifests (
                session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                kind, summary, parent_json, metadata_json, content_format,
                blob_hash, size_bytes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                latest.session_id,
                &run_id,
                &agent_id,
                latest.artifact_seq,
                latest.artifact_id,
                next_version,
                latest.kind,
                summary,
                parent_json,
                metadata_json,
                content_format,
                blob_hash,
                size_bytes,
                now_ms()
            ],
        )
        .map_err(|e| format!("INTERNAL: failed to insert artifact version: {}", e))?;

        let mut stmt = db
            .prepare(
                "SELECT
                    session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                    kind, summary, parent_json,
                    metadata_json, content_format, blob_hash, size_bytes, created_at
                 FROM artifact_manifests
                 WHERE session_id = ?1 AND artifact_id = ?2 AND version = ?3",
            )
            .map_err(|e| format!("INTERNAL: failed to prepare artifact version fetch: {}", e))?;
        let row = stmt
            .query_row(
                params![session_id, input.artifact_id, next_version],
                |row| parse_manifest_row(row),
            )
            .map_err(|e| format!("INTERNAL: failed to fetch artifact version: {}", e))?;
        manifest_row_to_api(row, false)
    })();

    match &result {
        Ok(v) => tool_log(
            "db_artifact_version",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": v.artifact_id,
                "version": v.version,
                "blobHash": v.blob_hash
            }),
        ),
        Err(e) => tool_log(
            "db_artifact_version",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_artifact_get(
    session_id: String,
    artifact_id: String,
    version: Option<i64>,
    include_content: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ArtifactManifest, String> {
    let start = Instant::now();
    tool_log(
        "db_artifact_get",
        "start",
        json!({
            "sessionId": session_id,
            "artifactId": artifact_id,
            "version": version
        }),
    );

    let result: Result<ArtifactManifest, String> = (|| {
        validate_non_empty(&session_id, "sessionId")?;
        validate_non_empty(&artifact_id, "artifactId")?;
        let include_content = include_content.unwrap_or(true);
        let db = state.db.lock().unwrap();

        let row = if let Some(v) = version {
            let mut stmt = db
                .prepare(
                    "SELECT
                        session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                        kind, summary, parent_json,
                        metadata_json, content_format, blob_hash, size_bytes, created_at
                     FROM artifact_manifests
                     WHERE session_id = ?1 AND artifact_id = ?2 AND version = ?3",
                )
                .map_err(|e| format!("INTERNAL: failed to prepare artifact get query: {}", e))?;
            stmt.query_row(params![session_id, artifact_id, v], |row| {
                parse_manifest_row(row)
            })
            .optional()
            .map_err(|e| format!("INTERNAL: failed to query artifact: {}", e))?
        } else {
            load_latest_manifest_row(&db, &session_id, &artifact_id)?
        };

        let row = row.ok_or_else(|| {
            if let Some(v) = version {
                format!(
                    "NOT_FOUND: artifact {} version {} not found",
                    artifact_id, v
                )
            } else {
                format!("NOT_FOUND: artifact {} not found", artifact_id)
            }
        })?;
        manifest_row_to_api(row, include_content)
    })();

    match &result {
        Ok(v) => tool_log(
            "db_artifact_get",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": v.artifact_id,
                "version": v.version
            }),
        ),
        Err(e) => tool_log(
            "db_artifact_get",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_artifact_list(
    session_id: String,
    input: ArtifactListInput,
    state: State<'_, AppState>,
) -> Result<Vec<ArtifactManifest>, String> {
    let start = Instant::now();
    tool_log(
        "db_artifact_list",
        "start",
        json!({
            "sessionId": session_id,
            "runId": input.run_id,
            "agentId": input.agent_id,
            "kind": input.kind,
            "latestOnly": input.latest_only,
            "limit": input.limit
        }),
    );

    let result: Result<Vec<ArtifactManifest>, String> = (|| {
        validate_non_empty(&session_id, "sessionId")?;
        let db = state.db.lock().unwrap();
        let mut sql = String::from(
            "SELECT
                m.session_id, m.run_id, m.agent_id, m.artifact_seq, m.artifact_id, m.version,
                m.kind, m.summary, m.parent_json,
                m.metadata_json, m.content_format, m.blob_hash, m.size_bytes, m.created_at
             FROM artifact_manifests m
             WHERE m.session_id = ?1",
        );
        let mut args: Vec<SqlValue> = vec![SqlValue::from(session_id)];
        let mut arg_idx = 2usize;

        if let Some(run_id) = input.run_id.filter(|v| !v.trim().is_empty()) {
            sql.push_str(&format!(" AND m.run_id = ?{}", arg_idx));
            args.push(SqlValue::from(run_id));
            arg_idx += 1;
        }
        if let Some(agent_id) = input.agent_id.filter(|v| !v.trim().is_empty()) {
            sql.push_str(&format!(" AND m.agent_id = ?{}", arg_idx));
            args.push(SqlValue::from(agent_id));
            arg_idx += 1;
        }
        if let Some(kind) = input.kind.filter(|v| !v.trim().is_empty()) {
            sql.push_str(&format!(" AND m.kind = ?{}", arg_idx));
            args.push(SqlValue::from(kind));
            arg_idx += 1;
        }
        if input.latest_only.unwrap_or(true) {
            sql.push_str(
                " AND m.version = (
                    SELECT MAX(v.version)
                    FROM artifact_manifests v
                    WHERE v.session_id = m.session_id
                      AND v.artifact_id = m.artifact_id
                )",
            );
        }

        sql.push_str(" ORDER BY m.created_at DESC");
        let limit = input.limit.unwrap_or(200).clamp(1, 1000) as i64;
        sql.push_str(&format!(" LIMIT ?{}", arg_idx));
        args.push(SqlValue::from(limit));

        let mut stmt = db
            .prepare(&sql)
            .map_err(|e| format!("INTERNAL: failed to prepare artifact list query: {}", e))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), |row| {
                parse_manifest_row(row)
            })
            .map_err(|e| format!("INTERNAL: failed to run artifact list query: {}", e))?;

        let mut manifests = Vec::new();
        for row in rows {
            let parsed =
                row.map_err(|e| format!("INTERNAL: failed to parse artifact row: {}", e))?;
            manifests.push(manifest_row_to_api(parsed, false)?);
        }
        Ok(manifests)
    })();

    match &result {
        Ok(v) => tool_log(
            "db_artifact_list",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "count": v.len()
            }),
        ),
        Err(e) => tool_log(
            "db_artifact_list",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn db_delete_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let start = Instant::now();
    tool_log("db_delete_session", "start", json!({ "id": id }));

    let result: Result<(), String> = (|| {
        let db = state.db.lock().unwrap();
        db.execute(
            "DELETE FROM artifact_manifests WHERE session_id = ?1",
            params![&id],
        )
        .map_err(|e| e.to_string())?;
        db.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![&id])
            .map_err(|e| e.to_string())?;
        let _ = gc_orphaned_artifact_blobs(&db);
        Ok(())
    })();

    match &result {
        Ok(()) => tool_log(
            "db_delete_session",
            "ok",
            json!({ "durationMs": start.elapsed().as_millis() as u64 }),
        ),
        Err(e) => tool_log(
            "db_delete_session",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::OnceLock;
    use tempfile::tempdir;

    fn init_artifact_schema(conn: &Connection) {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS artifact_blobs (
                hash             TEXT    PRIMARY KEY,
                storage_rel_path TEXT    NOT NULL,
                content_format   TEXT    NOT NULL,
                size_bytes       INTEGER NOT NULL,
                created_at       INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS artifact_manifests (
                session_id     TEXT    NOT NULL,
                run_id         TEXT    NOT NULL,
                agent_id       TEXT    NOT NULL,
                artifact_seq   INTEGER NOT NULL,
                artifact_id    TEXT    NOT NULL,
                version        INTEGER NOT NULL,
                kind           TEXT    NOT NULL,
                summary        TEXT    NOT NULL DEFAULT '',
                parent_json    TEXT    NOT NULL DEFAULT 'null',
                metadata_json  TEXT    NOT NULL DEFAULT '{}',
                content_format TEXT    NOT NULL,
                blob_hash      TEXT    NOT NULL,
                size_bytes     INTEGER NOT NULL,
                created_at     INTEGER NOT NULL,
                PRIMARY KEY (session_id, artifact_id, version)
            );
        ",
        )
        .unwrap();
    }

    #[test]
    fn test_db_session_lifecycle() {
        // Use an in-memory SQLite database for testing
        let conn = Connection::open_in_memory().unwrap();
        // Create the schema
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS sessions (
                id               TEXT    PRIMARY KEY,
                label            TEXT    NOT NULL,
                icon             TEXT    NOT NULL,
                mode             TEXT    NOT NULL,
                tab_title        TEXT    NOT NULL DEFAULT '',
                cwd              TEXT    NOT NULL DEFAULT '',
                model            TEXT    NOT NULL DEFAULT '',
                plan_markdown    TEXT    NOT NULL DEFAULT '',
                plan_version     INTEGER NOT NULL DEFAULT 0,
                plan_updated_at  INTEGER NOT NULL DEFAULT 0,
                chat_messages    TEXT    NOT NULL DEFAULT '[]',
                api_messages     TEXT    NOT NULL DEFAULT '[]',
                todos            TEXT    NOT NULL DEFAULT '[]',
                archived         INTEGER NOT NULL DEFAULT 0,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL,
                review_edits     TEXT    NOT NULL DEFAULT '[]',
                worktree_path    TEXT    NOT NULL DEFAULT '',
                worktree_branch  TEXT    NOT NULL DEFAULT '',
                worktree_declined INTEGER NOT NULL DEFAULT 0,
                show_debug       INTEGER NOT NULL DEFAULT 0,
                advanced_options TEXT    NOT NULL DEFAULT '{}'
            );
        ",
        )
        .unwrap();

        // Simulate AppState
        let state = AppState {
            pty_writers: Mutex::new(HashMap::new()),
            pty_masters: Mutex::new(HashMap::new()),
            db: Mutex::new(conn),
        };

        // We use State<'static, AppState> via tauri::State but since we can't easily construct a
        // Tauri State without an app, we'll test the SQL logic directly on our state.db.
        let db = state.db.lock().unwrap();

        // 1. Upsert a new session
        let session = PersistedSession {
            id: "session_1".to_string(),
            label: "Test Session".to_string(),
            icon: "test-icon".to_string(),
            mode: "test-mode".to_string(),
            tab_title: "Tab 1".to_string(),
            cwd: "/tmp".to_string(),
            model: "test-model".to_string(),
            plan_markdown: "".to_string(),
            plan_version: 0,
            plan_updated_at: 0,
            chat_messages: "[]".to_string(),
            api_messages: "[]".to_string(),
            todos: "[]".to_string(),
            review_edits: "[]".to_string(),
            archived: false,
            created_at: 1000,
            updated_at: 1000,
            worktree_path: "".to_string(),
            worktree_branch: "".to_string(),
            worktree_declined: false,
            show_debug: false,
            advanced_options: "{}".to_string(),
        };

        db.execute(
            "INSERT INTO sessions (
                id, label, icon, mode, tab_title, cwd, model,
                plan_markdown, plan_version, plan_updated_at,
                chat_messages, api_messages, todos, review_edits,
                archived, created_at, updated_at,
                worktree_path, worktree_branch, worktree_declined, show_debug
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            rusqlite::params![
                session.id,
                session.label,
                session.icon,
                session.mode,
                session.tab_title,
                session.cwd,
                session.model,
                session.plan_markdown,
                session.plan_version,
                session.plan_updated_at,
                session.chat_messages,
                session.api_messages,
                session.todos,
                session.review_edits,
                session.archived as i64,
                session.created_at,
                session.updated_at,
                session.worktree_path,
                session.worktree_branch,
                session.worktree_declined as i64,
                session.show_debug as i64,
            ],
        )
        .unwrap();

        // 2. Load the session
        let mut stmt = db
            .prepare("SELECT id, label, cwd FROM sessions WHERE archived = 0")
            .unwrap();
        let mut rows = stmt.query([]).unwrap();

        if let Some(row) = rows.next().unwrap() {
            let id: String = row.get(0).unwrap();
            let label: String = row.get(1).unwrap();
            let cwd: String = row.get(2).unwrap();

            assert_eq!(id, "session_1");
            assert_eq!(label, "Test Session");
            assert_eq!(cwd, "/tmp");
        } else {
            panic!("Expected session not found");
        }

        // 3. Archive the session
        db.execute(
            "UPDATE sessions SET archived = 1 WHERE id = ?1",
            rusqlite::params!["session_1"],
        )
        .unwrap();

        // 4. Verify it's no longer loaded as active
        let mut count_stmt = db
            .prepare("SELECT count(*) FROM sessions WHERE archived = 0")
            .unwrap();
        let count: i64 = count_stmt.query_row([], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_parse_login_shell_probe_output_extracts_and_trims_keys() {
        let parsed = parse_login_shell_probe_output(
            "noise before\n\
             __RAKH_OPENAI_API_KEY__  sk-openai-from-shell  \n\
             __RAKH_ANTHROPIC_AUTH_TOKEN__   \n\
             __RAKH_ANTHROPIC_API_KEY__  sk-anthropic-from-shell  \n\
             noise after\n",
        );

        assert_eq!(
            parsed.openai_api_key.as_deref(),
            Some("sk-openai-from-shell")
        );
        assert!(
            parsed.anthropic_auth_token.is_none(),
            "Whitespace auth token should be treated as missing"
        );
        assert_eq!(
            parsed.anthropic_api_key.as_deref(),
            Some("sk-anthropic-from-shell")
        );
    }

    #[test]
    fn test_provider_env_api_keys_merge_prefers_existing_values() {
        let mut process_keys = ProviderEnvApiKeys {
            openai_api_key: Some("sk-openai-process".to_string()),
            anthropic_auth_token: None,
            anthropic_api_key: None,
        };
        let shell_keys = ProviderEnvApiKeys {
            openai_api_key: Some("sk-openai-shell".to_string()),
            anthropic_auth_token: Some("sk-anthropic-auth-shell".to_string()),
            anthropic_api_key: Some("sk-anthropic-shell".to_string()),
        };

        process_keys.merge_missing_from(shell_keys);

        assert_eq!(
            process_keys.openai_api_key.as_deref(),
            Some("sk-openai-process"),
            "Process env should win when already populated",
        );
        assert_eq!(
            process_keys.preferred_anthropic_key().as_deref(),
            Some("sk-anthropic-auth-shell"),
            "Anthropic auth token should be preferred over ANTHROPIC_API_KEY",
        );
        assert!(process_keys.has_any_key());
    }

    #[test]
    fn test_artifact_dedup_version_and_gc() {
        static ENV_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();

        let tmp = tempdir().unwrap();
        let prev_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", tmp.path());

        let conn = Connection::open_in_memory().unwrap();
        init_artifact_schema(&conn);

        let content = "# report\n\nhello";
        let (hash_a, size_a) = upsert_blob_record(&conn, content, "markdown").unwrap();
        let (hash_b, size_b) = upsert_blob_record(&conn, content, "markdown").unwrap();
        assert_eq!(hash_a, hash_b);
        assert_eq!(size_a, size_b);

        let run_id = "run_2026-03-03T12-20-31-123Z_0001";
        let agent_id = "agent_main";
        let artifact_id = "report_deadbeef".to_string();
        conn.execute(
            "INSERT INTO artifact_manifests (
                session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                kind, summary, parent_json, metadata_json,
                content_format, blob_hash, size_bytes, created_at
             ) VALUES (?1, ?2, ?3, 1, ?4, 1, 'report', 'v1', 'null', '{}', 'markdown', ?5, ?6, ?7)",
            params![
                "tab-1",
                run_id,
                agent_id,
                artifact_id,
                hash_a,
                size_a,
                now_ms()
            ],
        )
        .unwrap();

        let parent_ref = format!("{{\"artifactId\":\"{}\",\"version\":1}}", artifact_id);
        conn.execute(
            "INSERT INTO artifact_manifests (
                session_id, run_id, agent_id, artifact_seq, artifact_id, version,
                kind, summary, parent_json, metadata_json,
                content_format, blob_hash, size_bytes, created_at
             ) VALUES (?1, ?2, ?3, 1, ?4, 2, 'report', 'v2', ?5, '{}', 'markdown', ?6, ?7, ?8)",
            params![
                "tab-1",
                run_id,
                agent_id,
                artifact_id,
                parent_ref,
                hash_a,
                size_a,
                now_ms()
            ],
        )
        .unwrap();

        let latest = load_latest_manifest_row(&conn, "tab-1", &artifact_id)
            .unwrap()
            .expect("latest artifact row");
        assert_eq!(latest.version, 2);

        let api = manifest_row_to_api(latest, true).unwrap();
        assert_eq!(api.content.as_deref(), Some(content));

        let blob_root = ensure_artifact_blob_root().unwrap();
        let blob_path: PathBuf = blob_root.join(blob_rel_path(&hash_a));
        assert!(blob_path.exists());

        conn.execute(
            "DELETE FROM artifact_manifests WHERE session_id = ?1",
            params!["tab-1"],
        )
        .unwrap();
        let removed = gc_orphaned_artifact_blobs(&conn).unwrap();
        assert_eq!(removed, 1);
        assert!(!blob_path.exists());

        match prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn test_load_provider_env_api_keys_reads_env_vars() {
        static ENV_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_TEST_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();

        let prev_openai = std::env::var("OPENAI_API_KEY").ok();
        let prev_anthropic_auth = std::env::var("ANTHROPIC_AUTH_TOKEN").ok();
        let prev_anthropic = std::env::var("ANTHROPIC_API_KEY").ok();

        std::env::set_var("OPENAI_API_KEY", "  sk-openai-from-env  ");
        std::env::set_var("ANTHROPIC_AUTH_TOKEN", "  sk-anthropic-auth-from-env  ");
        std::env::set_var("ANTHROPIC_API_KEY", "  sk-anthropic-from-env  ");

        let res = load_provider_env_api_keys().unwrap();
        assert_eq!(
            res["openaiApiKey"].as_str(),
            Some("sk-openai-from-env"),
            "OpenAI key should be read and trimmed from env",
        );
        assert_eq!(
            res["anthropicApiKey"].as_str(),
            Some("sk-anthropic-auth-from-env"),
            "Anthropic key should prefer ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY",
        );

        std::env::set_var("OPENAI_API_KEY", "   ");
        std::env::remove_var("ANTHROPIC_AUTH_TOKEN");
        std::env::remove_var("ANTHROPIC_API_KEY");

        let res_empty = load_provider_env_api_keys().unwrap();
        assert!(
            res_empty["openaiApiKey"].is_null(),
            "Whitespace-only OPENAI_API_KEY should resolve to null",
        );
        assert!(
            res_empty["anthropicApiKey"].is_null(),
            "Missing ANTHROPIC_API_KEY should resolve to null",
        );

        match prev_openai {
            Some(v) => std::env::set_var("OPENAI_API_KEY", v),
            None => std::env::remove_var("OPENAI_API_KEY"),
        }
        match prev_anthropic_auth {
            Some(v) => std::env::set_var("ANTHROPIC_AUTH_TOKEN", v),
            None => std::env::remove_var("ANTHROPIC_AUTH_TOKEN"),
        }
        match prev_anthropic {
            Some(v) => std::env::set_var("ANTHROPIC_API_KEY", v),
            None => std::env::remove_var("ANTHROPIC_API_KEY"),
        }
    }
}
