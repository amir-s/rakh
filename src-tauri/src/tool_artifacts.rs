use crate::logging::LogContext;
use crate::utils::{app_store_root, now_ms, tool_log_with_context};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;

const TOOL_ARTIFACT_PAYLOAD_FILENAME: &str = "payload.txt";
const TOOL_ARTIFACT_META_FILENAME: &str = "meta.json";
const MAX_TOOL_ARTIFACT_GET_BYTES: usize = 20_000;
const MAX_TOOL_ARTIFACT_SEARCH_MATCHES: usize = 50;
const MAX_TOOL_ARTIFACT_SEARCH_CONTEXT_LINES: usize = 3;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactMeta {
    pub artifact_id: String,
    pub created_at_ms: i64,
    pub run_id: String,
    pub tab_id: String,
    pub agent_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub source_kind: String,
    pub policy_id: String,
    pub original_format: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub line_count: Option<usize>,
    pub intention: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactCreateInput {
    pub run_id: String,
    pub tab_id: String,
    pub agent_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub source_kind: String,
    pub policy_id: String,
    pub original_format: String,
    pub content: String,
    pub intention: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactCreateOutput {
    pub artifact_id: String,
    pub created_at_ms: i64,
    pub size_bytes: i64,
    pub original_format: String,
    pub line_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactRange {
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactGetInput {
    pub artifact_id: String,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactGetOutput {
    pub artifact_id: String,
    pub original_format: String,
    pub content: String,
    pub size_bytes: i64,
    pub truncated: bool,
    pub line_count: Option<usize>,
    pub range: Option<ToolArtifactRange>,
    pub created_at_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactSearchInput {
    pub artifact_id: String,
    pub pattern: String,
    pub case_sensitive: Option<bool>,
    pub max_matches: Option<usize>,
    pub context_lines: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactSearchMatch {
    pub line_number: usize,
    pub line: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactSearchOutput {
    pub artifact_id: String,
    pub matches: Vec<ToolArtifactSearchMatch>,
    pub truncated: bool,
    pub match_count: usize,
    pub line_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifactDeleteOutput {
    pub deleted: bool,
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

fn validate_original_format(value: &str) -> Result<(), String> {
    match value {
        "text" | "json" => Ok(()),
        _ => Err("INVALID_ARGUMENT: originalFormat must be one of text, json".to_string()),
    }
}

fn tool_artifacts_root_from_store_root(store_root: &Path) -> PathBuf {
    store_root.join("artifacts").join("tools")
}

fn tool_artifacts_root() -> Result<PathBuf, String> {
    Ok(tool_artifacts_root_from_store_root(&app_store_root()?))
}

fn payload_path(dir: &Path) -> PathBuf {
    dir.join(TOOL_ARTIFACT_PAYLOAD_FILENAME)
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join(TOOL_ARTIFACT_META_FILENAME)
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| {
            format!(
                "INTERNAL: failed to remove malformed tool artifact {}: {}",
                path.display(),
                error
            )
        })?;
    }
    Ok(())
}

fn read_tool_artifact_meta(dir: &Path) -> Result<ToolArtifactMeta, String> {
    let meta_raw = fs::read_to_string(meta_path(dir)).map_err(|error| {
        format!(
            "INTERNAL: failed to read tool artifact metadata {}: {}",
            dir.display(),
            error
        )
    })?;
    serde_json::from_str(&meta_raw).map_err(|error| {
        format!(
            "INTERNAL: failed to parse tool artifact metadata {}: {}",
            dir.display(),
            error
        )
    })
}

fn read_tool_artifact_payload(dir: &Path) -> Result<String, String> {
    fs::read_to_string(payload_path(dir)).map_err(|error| {
        format!(
            "INTERNAL: failed to read tool artifact payload {}: {}",
            dir.display(),
            error
        )
    })
}

fn cleanup_malformed_tool_artifacts(root: &Path) -> Result<usize, String> {
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0usize;
    for entry in fs::read_dir(root).map_err(|error| {
        format!(
            "INTERNAL: failed to read tool artifact root {}: {}",
            root.display(),
            error
        )
    })? {
        let entry = entry.map_err(|error| format!("INTERNAL: {}", error))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let meta_ok = read_tool_artifact_meta(&path).is_ok();
        let payload_ok = payload_path(&path).is_file();
        if meta_ok && payload_ok {
            continue;
        }

        remove_dir_if_exists(&path)?;
        removed += 1;
    }

    Ok(removed)
}

fn resolve_tool_artifact_dir(root: &Path, artifact_id: &str) -> Result<PathBuf, String> {
    cleanup_malformed_tool_artifacts(root)?;

    if !root.exists() {
        return Err(format!("NOT_FOUND: tool artifact \"{}\" was not found", artifact_id));
    }

    for entry in fs::read_dir(root).map_err(|error| {
        format!(
            "INTERNAL: failed to read tool artifact root {}: {}",
            root.display(),
            error
        )
    })? {
        let entry = entry.map_err(|error| format!("INTERNAL: {}", error))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let meta = match read_tool_artifact_meta(&path) {
            Ok(meta) => meta,
            Err(_) => {
                remove_dir_if_exists(&path)?;
                continue;
            }
        };

        if !payload_path(&path).is_file() {
            remove_dir_if_exists(&path)?;
            continue;
        }

        if meta.artifact_id == artifact_id {
            return Ok(path);
        }
    }

    Err(format!("NOT_FOUND: tool artifact \"{}\" was not found", artifact_id))
}

fn create_tool_artifact_at_root(
    root: &Path,
    input: ToolArtifactCreateInput,
) -> Result<ToolArtifactCreateOutput, String> {
    validate_non_empty(&input.run_id, "runId")?;
    validate_non_empty(&input.tab_id, "tabId")?;
    validate_non_empty(&input.agent_id, "agentId")?;
    validate_non_empty(&input.tool_call_id, "toolCallId")?;
    validate_non_empty(&input.tool_name, "toolName")?;
    validate_non_empty(&input.source_kind, "sourceKind")?;
    validate_non_empty(&input.policy_id, "policyId")?;
    validate_non_empty(&input.original_format, "originalFormat")?;
    validate_original_format(&input.original_format)?;

    fs::create_dir_all(root).map_err(|error| {
        format!(
            "INTERNAL: failed to create tool artifact root {}: {}",
            root.display(),
            error
        )
    })?;
    cleanup_malformed_tool_artifacts(root)?;

    let created_at_ms = now_ms();
    let artifact_id = format!("toolart_{}", Uuid::new_v4().simple());
    let dir_name = format!("{}_{}", created_at_ms, &Uuid::new_v4().simple().to_string()[..8]);
    let dir_path = root.join(dir_name);
    fs::create_dir_all(&dir_path).map_err(|error| {
        format!(
            "INTERNAL: failed to create tool artifact directory {}: {}",
            dir_path.display(),
            error
        )
    })?;

    let line_count = input.content.lines().count();
    let meta = ToolArtifactMeta {
        artifact_id: artifact_id.clone(),
        created_at_ms,
        run_id: input.run_id,
        tab_id: input.tab_id,
        agent_id: input.agent_id,
        tool_call_id: input.tool_call_id,
        tool_name: input.tool_name,
        source_kind: input.source_kind,
        policy_id: input.policy_id,
        original_format: input.original_format.clone(),
        size_bytes: input.content.as_bytes().len() as i64,
        line_count: Some(line_count),
        intention: input.intention.filter(|value| !value.trim().is_empty()),
    };

    let write_result: Result<(), String> = (|| {
        let mut payload_file = fs::File::create(payload_path(&dir_path)).map_err(|error| {
            format!(
                "INTERNAL: failed to create tool artifact payload {}: {}",
                dir_path.display(),
                error
            )
        })?;
        payload_file
            .write_all(input.content.as_bytes())
            .map_err(|error| format!("INTERNAL: failed to write tool artifact payload: {}", error))?;

        let meta_json = serde_json::to_vec_pretty(&meta)
            .map_err(|error| format!("INTERNAL: failed to serialize tool artifact metadata: {}", error))?;
        let mut meta_file = fs::File::create(meta_path(&dir_path)).map_err(|error| {
            format!(
                "INTERNAL: failed to create tool artifact metadata {}: {}",
                dir_path.display(),
                error
            )
        })?;
        meta_file
            .write_all(&meta_json)
            .map_err(|error| format!("INTERNAL: failed to write tool artifact metadata: {}", error))?;

        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = remove_dir_if_exists(&dir_path);
        return Err(error);
    }

    Ok(ToolArtifactCreateOutput {
        artifact_id,
        created_at_ms,
        size_bytes: meta.size_bytes,
        original_format: meta.original_format,
        line_count,
    })
}

fn get_tool_artifact_at_root(
    root: &Path,
    input: ToolArtifactGetInput,
) -> Result<ToolArtifactGetOutput, String> {
    validate_non_empty(&input.artifact_id, "artifactId")?;

    let dir = resolve_tool_artifact_dir(root, &input.artifact_id)?;
    let meta = read_tool_artifact_meta(&dir)?;
    let content = read_tool_artifact_payload(&dir)?;

    let max_bytes = input
        .max_bytes
        .unwrap_or(MAX_TOOL_ARTIFACT_GET_BYTES as u64)
        .min(MAX_TOOL_ARTIFACT_GET_BYTES as u64) as usize;

    if input.start_line.is_some() || input.end_line.is_some() {
        let start_line = input.start_line.unwrap_or(1).max(1) as usize;
        let end_line = input.end_line.unwrap_or(u64::MAX) as usize;
        let mut lines = Vec::new();
        let mut total_lines = 0usize;
        let mut used_bytes = 0usize;
        let mut truncated = false;

        for (index, line) in io::BufReader::new(content.as_bytes()).lines().enumerate() {
            let line = line.map_err(|error| format!("INTERNAL: failed to read artifact lines: {}", error))?;
            total_lines += 1;
            let line_number = index + 1;
            if line_number < start_line || line_number > end_line {
                continue;
            }
            let line_bytes = line.as_bytes().len() + 1;
            if used_bytes + line_bytes > max_bytes {
                truncated = true;
                break;
            }
            used_bytes += line_bytes;
            lines.push(line);
        }

        return Ok(ToolArtifactGetOutput {
            artifact_id: meta.artifact_id,
            original_format: meta.original_format,
            content: lines.join("\n"),
            size_bytes: meta.size_bytes,
            truncated,
            line_count: Some(meta.line_count.unwrap_or(total_lines)),
            range: Some(ToolArtifactRange {
                start_line,
                end_line: if lines.is_empty() {
                    start_line
                } else {
                    start_line + lines.len().saturating_sub(1)
                },
            }),
            created_at_ms: meta.created_at_ms,
        });
    }

    let bytes = content.as_bytes();
    let truncated = bytes.len() > max_bytes;
    let slice = if truncated { &bytes[..max_bytes] } else { bytes };
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(ToolArtifactGetOutput {
        artifact_id: meta.artifact_id,
        original_format: meta.original_format,
        content,
        size_bytes: meta.size_bytes,
        truncated,
        line_count: meta.line_count,
        range: None,
        created_at_ms: meta.created_at_ms,
    })
}

fn search_tool_artifact_at_root(
    root: &Path,
    input: ToolArtifactSearchInput,
) -> Result<ToolArtifactSearchOutput, String> {
    validate_non_empty(&input.artifact_id, "artifactId")?;
    validate_non_empty(&input.pattern, "pattern")?;

    let dir = resolve_tool_artifact_dir(root, &input.artifact_id)?;
    let meta = read_tool_artifact_meta(&dir)?;
    let content = read_tool_artifact_payload(&dir)?;
    let lines: Vec<String> = io::BufReader::new(content.as_bytes())
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("INTERNAL: failed to read artifact lines: {}", error))?;

    let regex = RegexBuilder::new(&input.pattern)
        .case_insensitive(!(input.case_sensitive.unwrap_or(false)))
        .build()
        .map_err(|error| format!("INVALID_ARGUMENT: invalid regex pattern: {}", error))?;
    let max_matches = input
        .max_matches
        .unwrap_or(MAX_TOOL_ARTIFACT_SEARCH_MATCHES)
        .min(MAX_TOOL_ARTIFACT_SEARCH_MATCHES);
    let context_lines = input
        .context_lines
        .unwrap_or(0)
        .min(MAX_TOOL_ARTIFACT_SEARCH_CONTEXT_LINES);

    let mut matches = Vec::new();
    let mut match_count = 0usize;
    let mut truncated = false;

    for (index, line) in lines.iter().enumerate() {
        if !regex.is_match(line) {
            continue;
        }

        match_count += 1;
        if matches.len() >= max_matches {
            truncated = true;
            continue;
        }

        let before_start = index.saturating_sub(context_lines);
        let after_end = (index + context_lines + 1).min(lines.len());
        matches.push(ToolArtifactSearchMatch {
            line_number: index + 1,
            line: line.clone(),
            context_before: lines[before_start..index].to_vec(),
            context_after: lines[index + 1..after_end].to_vec(),
        });
    }

    Ok(ToolArtifactSearchOutput {
        artifact_id: meta.artifact_id,
        matches,
        truncated,
        match_count,
        line_count: meta.line_count.unwrap_or(lines.len()),
    })
}

fn delete_tool_artifact_at_root(root: &Path, artifact_id: &str) -> Result<ToolArtifactDeleteOutput, String> {
    validate_non_empty(artifact_id, "artifactId")?;

    match resolve_tool_artifact_dir(root, artifact_id) {
        Ok(dir) => {
            remove_dir_if_exists(&dir)?;
            Ok(ToolArtifactDeleteOutput { deleted: true })
        }
        Err(error) if error.starts_with("NOT_FOUND:") => Ok(ToolArtifactDeleteOutput { deleted: false }),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn tool_artifact_create(
    input: ToolArtifactCreateInput,
    log_context: Option<LogContext>,
) -> Result<ToolArtifactCreateOutput, String> {
    let start = Instant::now();
    tool_log_with_context(
        "tool_artifact_create",
        "start",
        json!({
            "toolCallId": input.tool_call_id,
            "toolName": input.tool_name,
            "policyId": input.policy_id,
            "originalFormat": input.original_format
        }),
        log_context.as_ref(),
    );

    let result = create_tool_artifact_at_root(&tool_artifacts_root()?, input);
    match &result {
        Ok(output) => tool_log_with_context(
            "tool_artifact_create",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": output.artifact_id,
                "sizeBytes": output.size_bytes,
                "originalFormat": output.original_format,
                "lineCount": output.line_count
            }),
            log_context.as_ref(),
        ),
        Err(error) => tool_log_with_context(
            "tool_artifact_create",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": error
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn tool_artifact_get(
    input: ToolArtifactGetInput,
    log_context: Option<LogContext>,
) -> Result<ToolArtifactGetOutput, String> {
    let start = Instant::now();
    tool_log_with_context(
        "tool_artifact_get",
        "start",
        json!({
            "artifactId": input.artifact_id,
            "startLine": input.start_line,
            "endLine": input.end_line,
            "maxBytes": input.max_bytes
        }),
        log_context.as_ref(),
    );

    let result = get_tool_artifact_at_root(&tool_artifacts_root()?, input);
    match &result {
        Ok(output) => tool_log_with_context(
            "tool_artifact_get",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": output.artifact_id,
                "truncated": output.truncated,
                "contentBytes": output.content.len()
            }),
            log_context.as_ref(),
        ),
        Err(error) => tool_log_with_context(
            "tool_artifact_get",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": error
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn tool_artifact_search(
    input: ToolArtifactSearchInput,
    log_context: Option<LogContext>,
) -> Result<ToolArtifactSearchOutput, String> {
    let start = Instant::now();
    tool_log_with_context(
        "tool_artifact_search",
        "start",
        json!({
            "artifactId": input.artifact_id,
            "pattern": input.pattern,
            "maxMatches": input.max_matches,
            "contextLines": input.context_lines
        }),
        log_context.as_ref(),
    );

    let result = search_tool_artifact_at_root(&tool_artifacts_root()?, input);
    match &result {
        Ok(output) => tool_log_with_context(
            "tool_artifact_search",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": output.artifact_id,
                "matchCount": output.match_count,
                "returnedMatches": output.matches.len(),
                "truncated": output.truncated
            }),
            log_context.as_ref(),
        ),
        Err(error) => tool_log_with_context(
            "tool_artifact_search",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": error
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn tool_artifact_delete(
    artifact_id: String,
    log_context: Option<LogContext>,
) -> Result<ToolArtifactDeleteOutput, String> {
    let start = Instant::now();
    tool_log_with_context(
        "tool_artifact_delete",
        "start",
        json!({ "artifactId": artifact_id }),
        log_context.as_ref(),
    );

    let result = delete_tool_artifact_at_root(&tool_artifacts_root()?, &artifact_id);
    match &result {
        Ok(output) => tool_log_with_context(
            "tool_artifact_delete",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": artifact_id,
                "deleted": output.deleted
            }),
            log_context.as_ref(),
        ),
        Err(error) => tool_log_with_context(
            "tool_artifact_delete",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "artifactId": artifact_id,
                "error": error
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_create_input(content: &str) -> ToolArtifactCreateInput {
        ToolArtifactCreateInput {
            run_id: "run_1".to_string(),
            tab_id: "tab_1".to_string(),
            agent_id: "agent_main".to_string(),
            tool_call_id: "tc_1".to_string(),
            tool_name: "workspace_search".to_string(),
            source_kind: "local".to_string(),
            policy_id: "huge-output".to_string(),
            original_format: "text".to_string(),
            content: content.to_string(),
            intention: Some("find build failures".to_string()),
        }
    }

    #[test]
    fn create_get_search_and_delete_tool_artifact() {
        let store_root = tempdir().expect("tempdir should succeed");
        let root = tool_artifacts_root_from_store_root(store_root.path());

        let created = create_tool_artifact_at_root(
            &root,
            make_create_input("line one\nfatal error happened here\nline three"),
        )
        .expect("create should succeed");
        assert!(created.artifact_id.starts_with("toolart_"));
        assert_eq!(created.line_count, 3);

        let fetched = get_tool_artifact_at_root(
            &root,
            ToolArtifactGetInput {
                artifact_id: created.artifact_id.clone(),
                start_line: Some(2),
                end_line: Some(2),
                max_bytes: None,
            },
        )
        .expect("get should succeed");
        assert_eq!(fetched.content, "fatal error happened here");
        assert_eq!(
            fetched.range,
            Some(ToolArtifactRange {
                start_line: 2,
                end_line: 2
            })
        );

        let search = search_tool_artifact_at_root(
            &root,
            ToolArtifactSearchInput {
                artifact_id: created.artifact_id.clone(),
                pattern: "error".to_string(),
                case_sensitive: None,
                max_matches: None,
                context_lines: Some(1),
            },
        )
        .expect("search should succeed");
        assert_eq!(search.match_count, 1);
        assert_eq!(search.matches.len(), 1);
        assert_eq!(search.matches[0].line_number, 2);
        assert_eq!(search.matches[0].context_before, vec!["line one".to_string()]);
        assert_eq!(search.matches[0].context_after, vec!["line three".to_string()]);

        let deleted = delete_tool_artifact_at_root(&root, &created.artifact_id)
            .expect("delete should succeed");
        assert!(deleted.deleted);
        let missing = delete_tool_artifact_at_root(&root, &created.artifact_id)
            .expect("delete missing should not error");
        assert!(!missing.deleted);
    }

    #[test]
    fn cleanup_malformed_tool_artifacts_removes_invalid_entries() {
        let store_root = tempdir().expect("tempdir should succeed");
        let root = tool_artifacts_root_from_store_root(store_root.path());
        fs::create_dir_all(&root).expect("root should be created");

        let created = create_tool_artifact_at_root(&root, make_create_input("ok"))
            .expect("create should succeed");
        assert!(resolve_tool_artifact_dir(&root, &created.artifact_id).is_ok());

        let broken_dir = root.join("broken");
        fs::create_dir_all(&broken_dir).expect("broken dir should be created");
        fs::write(meta_path(&broken_dir), "{bad json").expect("bad meta should be written");

        let removed = cleanup_malformed_tool_artifacts(&root).expect("cleanup should succeed");
        assert_eq!(removed, 1);
        assert!(!broken_dir.exists());
        assert!(resolve_tool_artifact_dir(&root, &created.artifact_id).is_ok());
    }
}
