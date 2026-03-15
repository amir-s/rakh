use crate::db::AppState;
use crate::utils::{app_store_root, now_ms, tool_log};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const TODO_STATES: [&str; 4] = ["todo", "doing", "blocked", "done"];
const TODO_NOTE_KINDS: [&str; 2] = ["learned", "critical"];
const TODO_NOTE_SOURCES: [&str; 2] = ["agent", "context_gateway"];
const MUTATION_INTENTS: [&str; 10] = [
    "exploration",
    "implementation",
    "refactor",
    "fix",
    "test",
    "build",
    "docs",
    "setup",
    "cleanup",
    "other",
];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoNoteItem {
    pub id: String,
    pub text: String,
    pub added_turn: i64,
    pub author: String,
    pub source: String,
    pub verified: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoMutationLogEntry {
    pub seq: i64,
    pub tool: String,
    pub turn: i64,
    pub actor: String,
    pub paths: Vec<String>,
    pub mutation_intent: String,
    pub tool_call_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub state: String,
    pub owner: String,
    pub created_turn: i64,
    pub updated_turn: i64,
    pub last_touched_turn: i64,
    pub files_touched: Vec<String>,
    pub things_learned: Vec<TodoNoteItem>,
    pub critical_info: Vec<TodoNoteItem>,
    pub mutation_log: Vec<TodoMutationLogEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoMutationResponse {
    pub items: Vec<TodoItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<TodoItem>,
    pub removed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoChangeEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo_id: Option<String>,
    pub change: String,
    pub changed_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoAddInput {
    pub title: String,
    pub owner: String,
    pub turn: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdatePatch {
    pub title: Option<String>,
    pub state: Option<String>,
    pub completion_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoUpdateInput {
    pub id: String,
    pub owner: String,
    pub turn: i64,
    pub patch: TodoUpdatePatch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRemoveInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoNoteAddInput {
    pub todo_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub author: String,
    pub turn: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRecordMutationInput {
    pub actor: String,
    pub turn: i64,
    pub tool: String,
    pub tool_call_id: String,
    pub mutation_intent: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoContextEnrichmentTodoUpdateInput {
    pub todo_id: String,
    #[serde(default)]
    pub verify_things_learned_note_ids: Vec<String>,
    #[serde(default)]
    pub verify_critical_info_note_ids: Vec<String>,
    #[serde(default)]
    pub append_things_learned: Vec<String>,
    #[serde(default)]
    pub append_critical_info: Vec<String>,
    #[serde(default)]
    pub remove_duplicate_things_learned_note_ids: Vec<String>,
    #[serde(default)]
    pub remove_duplicate_critical_info_note_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoContextEnrichmentInput {
    pub turn: i64,
    #[serde(default)]
    pub updates: Vec<TodoContextEnrichmentTodoUpdateInput>,
}

fn todo_store_root() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("sessions").join("todos"))
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err("INVALID_ARGUMENT: sessionId must not be empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("INVALID_ARGUMENT: sessionId must not contain path separators".to_string());
    }
    Ok(())
}

fn todo_file_path(session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(todo_store_root()?.join(format!("{}.json", session_id.trim())))
}

fn ensure_todo_store_root() -> Result<PathBuf, String> {
    let root = todo_store_root()?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("INTERNAL: cannot create todo store root: {}", error))?;
    Ok(root)
}

fn new_short_id() -> String {
    let hex = Uuid::new_v4().simple().to_string();
    hex.get(0..8).unwrap_or(&hex).to_string()
}

fn normalize_required_text(value: &str, field_name: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!(
            "INVALID_ARGUMENT: {} must not be empty",
            field_name
        ));
    }
    Ok(normalized.to_string())
}

fn validate_choice(value: &str, allowed: &[&str], field_name: &str) -> Result<String, String> {
    let normalized = normalize_required_text(value, field_name)?;
    if allowed.contains(&normalized.as_str()) {
        Ok(normalized)
    } else {
        Err(format!(
            "INVALID_ARGUMENT: {} must be one of {}",
            field_name,
            allowed.join(", ")
        ))
    }
}

fn normalize_workspace_path(path: &str) -> Result<String, String> {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("INVALID_ARGUMENT: touchedPaths entries must not be empty".to_string());
    }
    if normalized.starts_with('/') {
        return Err(
            "INVALID_ARGUMENT: touchedPaths entries must be workspace-relative".to_string(),
        );
    }
    if normalized.split('/').any(|segment| segment == "..") {
        return Err(
            "INVALID_ARGUMENT: touchedPaths entries must not contain '..' segments".to_string(),
        );
    }
    Ok(normalized)
}

fn normalize_paths(paths: &[String]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in paths {
        let normalized = normalize_workspace_path(path)?;
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    Ok(out)
}

fn normalize_note_match_key(text: &str) -> String {
    let collapsed = text.trim().split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .to_lowercase()
        .trim_end_matches(|c| matches!(c, '.' | '!' | '?'))
        .to_string()
}

fn notes_are_duplicates(left: &str, right: &str) -> bool {
    left == right || normalize_note_match_key(left) == normalize_note_match_key(right)
}

fn dedupe_string_ids(ids: &[String], field_name: &str) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        let normalized = normalize_required_text(id, field_name)?;
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    Ok(out)
}

fn apply_note_enrichment(
    notes: &mut Vec<TodoNoteItem>,
    verify_ids: &[String],
    append_texts: &[String],
    remove_duplicate_ids: &[String],
    note_bucket: &str,
    turn: i64,
) -> Result<bool, String> {
    let verify_ids = dedupe_string_ids(verify_ids, &format!("{}.verifyIds", note_bucket))?;
    let remove_duplicate_ids = dedupe_string_ids(
        remove_duplicate_ids,
        &format!("{}.removeDuplicateIds", note_bucket),
    )?;

    let mut changed = false;

    for note_id in &verify_ids {
        let index = notes
            .iter()
            .position(|note| note.id == *note_id)
            .ok_or_else(|| format!("NOT_FOUND: Note {} not found in {}", note_id, note_bucket))?;
        if !notes[index].verified {
            notes[index].verified = true;
            changed = true;
        }
    }

    let mut removal_indexes = Vec::new();
    for note_id in &remove_duplicate_ids {
        let index = notes
            .iter()
            .position(|note| note.id == *note_id)
            .ok_or_else(|| format!("NOT_FOUND: Note {} not found in {}", note_id, note_bucket))?;
        let note_text = notes[index].text.clone();
        let has_earlier_duplicate = notes
            .iter()
            .take(index)
            .any(|existing| notes_are_duplicates(existing.text.as_str(), note_text.as_str()));
        if !has_earlier_duplicate {
            return Err(format!(
                "INVALID_ARGUMENT: Note {} in {} is not a later exact/near-exact duplicate",
                note_id, note_bucket
            ));
        }
        removal_indexes.push(index);
    }

    removal_indexes.sort_unstable();
    removal_indexes.dedup();
    for index in removal_indexes.into_iter().rev() {
        notes.remove(index);
        changed = true;
    }

    for text in append_texts {
        let normalized_text =
            normalize_required_text(text, &format!("{}.appendText", note_bucket))?;
        if notes
            .iter()
            .any(|existing| notes_are_duplicates(existing.text.as_str(), normalized_text.as_str()))
        {
            continue;
        }
        let source = validate_choice("context_gateway", &TODO_NOTE_SOURCES, "source")?;
        notes.push(TodoNoteItem {
            id: new_short_id(),
            text: normalized_text,
            added_turn: turn,
            author: "context_gateway".to_string(),
            source,
            verified: true,
        });
        changed = true;
    }

    Ok(changed)
}

fn load_todos_from_disk(path: &Path) -> Vec<TodoItem> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<TodoItem>>(&raw).unwrap_or_default()
}

fn write_todos_to_disk(path: &Path, items: &[TodoItem]) -> Result<(), String> {
    ensure_todo_store_root()?;
    let serialized = serde_json::to_vec_pretty(items)
        .map_err(|error| format!("INTERNAL: failed to serialize todos: {}", error))?;
    let tmp_path = path.with_extension(format!("json.tmp-{}", new_short_id()));
    fs::write(&tmp_path, serialized)
        .map_err(|error| format!("INTERNAL: cannot write todo temp file: {}", error))?;
    fs::rename(&tmp_path, path)
        .map_err(|error| format!("INTERNAL: cannot replace todo file: {}", error))?;
    Ok(())
}

fn recompute_files_touched(item: &mut TodoItem) {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for entry in &item.mutation_log {
        for path in &entry.paths {
            if seen.insert(path.clone()) {
                files.push(path.clone());
            }
        }
    }
    item.files_touched = files;
}

fn active_todo_index(items: &[TodoItem]) -> Result<usize, String> {
    let active: Vec<usize> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| (item.state == "doing").then_some(index))
        .collect();
    match active.as_slice() {
        [index] => Ok(*index),
        [] => Err("CONFLICT: exactly one active todo is required".to_string()),
        _ => Err("CONFLICT: multiple active todos found".to_string()),
    }
}

fn enforce_single_doing(
    items: &[TodoItem],
    candidate_id: &str,
    next_state: &str,
) -> Result<(), String> {
    if next_state != "doing" {
        return Ok(());
    }
    let conflict = items
        .iter()
        .any(|item| item.id != candidate_id && item.state == "doing");
    if conflict {
        return Err("CONFLICT: only one todo can be in the doing state".to_string());
    }
    Ok(())
}

fn emit_todo_changed(app_handle: &AppHandle, payload: &TodoChangeEvent) {
    let _ = app_handle.emit("todo_changed", payload);
}

fn session_lock(state: &State<'_, AppState>, session_id: &str) -> Arc<Mutex<()>> {
    let mut locks = state.todo_locks.lock().unwrap();
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn mutate_todos<R>(
    session_id: &str,
    state: &State<'_, AppState>,
    mutator: impl FnOnce(&mut Vec<TodoItem>) -> Result<R, String>,
) -> Result<R, String> {
    let lock = session_lock(state, session_id);
    let _guard = lock.lock().unwrap();
    let path = todo_file_path(session_id)?;
    let mut items = load_todos_from_disk(&path);
    let result = mutator(&mut items)?;
    write_todos_to_disk(&path, &items)?;
    Ok(result)
}

fn build_response(
    items: &[TodoItem],
    item: Option<&TodoItem>,
    removed: bool,
) -> TodoMutationResponse {
    TodoMutationResponse {
        items: items.to_vec(),
        item: item.cloned(),
        removed,
    }
}

#[tauri::command]
pub fn todo_store_load(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TodoItem>, String> {
    let start = Instant::now();
    tool_log(
        "todo_store_load",
        "start",
        json!({ "sessionId": session_id }),
    );
    let result = (|| {
        let lock = session_lock(&state, &session_id);
        let _guard = lock.lock().unwrap();
        let path = todo_file_path(&session_id)?;
        Ok(load_todos_from_disk(&path))
    })();
    match &result {
        Ok(items) => tool_log(
            "todo_store_load",
            "ok",
            json!({ "sessionId": session_id, "count": items.len(), "durationMs": start.elapsed().as_millis() as u64 }),
        ),
        Err(error) => tool_log(
            "todo_store_load",
            "err",
            json!({ "sessionId": session_id, "error": error, "durationMs": start.elapsed().as_millis() as u64 }),
        ),
    }
    result
}

#[tauri::command]
pub fn todo_store_get_path(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let lock = session_lock(&state, &session_id);
    let _guard = lock.lock().unwrap();
    let path = todo_file_path(&session_id)?;
    if !path.exists() {
        write_todos_to_disk(&path, &[])?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn todo_store_add(
    session_id: String,
    input: TodoAddInput,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TodoMutationResponse, String> {
    let start = Instant::now();
    tool_log(
        "todo_store_add",
        "start",
        json!({ "sessionId": session_id }),
    );
    let result = mutate_todos(&session_id, &state, |items| {
        let title = normalize_required_text(&input.title, "title")?;
        let owner = normalize_required_text(&input.owner, "owner")?;
        let item = TodoItem {
            id: new_short_id(),
            title,
            state: "todo".to_string(),
            owner,
            created_turn: input.turn,
            updated_turn: input.turn,
            last_touched_turn: input.turn,
            files_touched: Vec::new(),
            things_learned: Vec::new(),
            critical_info: Vec::new(),
            mutation_log: Vec::new(),
            completion_note: None,
        };
        items.push(item);
        Ok(build_response(items, items.last(), false))
    });
    match &result {
        Ok(response) => {
            emit_todo_changed(
                &app_handle,
                &TodoChangeEvent {
                    session_id: session_id.clone(),
                    todo_id: response.item.as_ref().map(|item| item.id.clone()),
                    change: "added".to_string(),
                    changed_at: now_ms(),
                },
            );
            tool_log(
                "todo_store_add",
                "ok",
                json!({ "sessionId": session_id, "durationMs": start.elapsed().as_millis() as u64 }),
            );
        }
        Err(error) => tool_log(
            "todo_store_add",
            "err",
            json!({ "sessionId": session_id, "error": error, "durationMs": start.elapsed().as_millis() as u64 }),
        ),
    }
    result
}

#[tauri::command]
pub fn todo_store_update(
    session_id: String,
    input: TodoUpdateInput,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TodoMutationResponse, String> {
    let start = Instant::now();
    tool_log(
        "todo_store_update",
        "start",
        json!({ "sessionId": session_id, "todoId": input.id }),
    );
    let result = mutate_todos(&session_id, &state, |items| {
        normalize_required_text(&input.owner, "owner")?;
        let index = items
            .iter()
            .position(|item| item.id == input.id)
            .ok_or_else(|| format!("NOT_FOUND: Todo {} not found", input.id))?;
        let next_state = if let Some(state) = input.patch.state.as_deref() {
            validate_choice(state, &TODO_STATES, "state")?
        } else {
            items[index].state.clone()
        };
        enforce_single_doing(items, &input.id, &next_state)?;

        let next_title = if let Some(title) = input.patch.title.as_deref() {
            Some(normalize_required_text(title, "title")?)
        } else {
            None
        };
        let current_state = items[index].state.clone();
        let transitioning_to_done = current_state != "done" && next_state == "done";
        let completion_note = input
            .patch
            .completion_note
            .as_deref()
            .map(|value| normalize_required_text(value, "completionNote"))
            .transpose()?;

        if transitioning_to_done && completion_note.is_none() {
            return Err(
                "INVALID_ARGUMENT: completionNote is required when marking a todo done".to_string(),
            );
        }

        let item = items.get_mut(index).unwrap();
        if let Some(title) = next_title {
            item.title = title;
        }
        item.state = next_state;
        if item.state == "done" {
            if let Some(note) = completion_note {
                item.completion_note = Some(note);
            }
        } else {
            item.completion_note = None;
        }
        item.updated_turn = input.turn;
        item.last_touched_turn = input.turn;
        let item_snapshot = item.clone();
        Ok(build_response(items, Some(&item_snapshot), false))
    });
    match &result {
        Ok(response) => {
            emit_todo_changed(
                &app_handle,
                &TodoChangeEvent {
                    session_id: session_id.clone(),
                    todo_id: response.item.as_ref().map(|item| item.id.clone()),
                    change: "updated".to_string(),
                    changed_at: now_ms(),
                },
            );
            tool_log(
                "todo_store_update",
                "ok",
                json!({ "sessionId": session_id, "durationMs": start.elapsed().as_millis() as u64 }),
            );
        }
        Err(error) => tool_log(
            "todo_store_update",
            "err",
            json!({ "sessionId": session_id, "error": error, "durationMs": start.elapsed().as_millis() as u64 }),
        ),
    }
    result
}

#[tauri::command]
pub fn todo_store_remove(
    session_id: String,
    input: TodoRemoveInput,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TodoMutationResponse, String> {
    let result = mutate_todos(&session_id, &state, |items| {
        let before = items.len();
        items.retain(|item| item.id != input.id);
        Ok(build_response(items, None, items.len() != before))
    });
    if let Ok(response) = &result {
        emit_todo_changed(
            &app_handle,
            &TodoChangeEvent {
                session_id: session_id,
                todo_id: Some(input.id),
                change: "removed".to_string(),
                changed_at: now_ms(),
            },
        );
        if !response.removed {
            return Ok(response.clone());
        }
    }
    result
}

#[tauri::command]
pub fn todo_store_note_add(
    session_id: String,
    input: TodoNoteAddInput,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TodoMutationResponse, String> {
    let result = mutate_todos(&session_id, &state, |items| {
        let kind = validate_choice(&input.kind, &TODO_NOTE_KINDS, "kind")?;
        let text = normalize_required_text(&input.text, "text")?;
        let author = normalize_required_text(&input.author, "author")?;
        let index = if let Some(todo_id) = input.todo_id.as_deref() {
            items
                .iter()
                .position(|item| item.id == todo_id)
                .ok_or_else(|| format!("NOT_FOUND: Todo {} not found", todo_id))?
        } else {
            active_todo_index(items)?
        };
        let note = TodoNoteItem {
            id: new_short_id(),
            text,
            added_turn: input.turn,
            author,
            source: "agent".to_string(),
            verified: false,
        };
        let item = items.get_mut(index).unwrap();
        if kind == "learned" {
            item.things_learned.push(note);
        } else {
            item.critical_info.push(note);
        }
        item.updated_turn = input.turn;
        item.last_touched_turn = input.turn;
        let item_snapshot = item.clone();
        Ok(build_response(items, Some(&item_snapshot), false))
    });
    if let Ok(response) = &result {
        emit_todo_changed(
            &app_handle,
            &TodoChangeEvent {
                session_id: session_id,
                todo_id: response.item.as_ref().map(|item| item.id.clone()),
                change: "noted".to_string(),
                changed_at: now_ms(),
            },
        );
    }
    result
}

#[tauri::command]
pub fn todo_store_record_mutation(
    session_id: String,
    input: TodoRecordMutationInput,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TodoMutationResponse, String> {
    let result = mutate_todos(&session_id, &state, |items| {
        let actor = normalize_required_text(&input.actor, "actor")?;
        let tool = normalize_required_text(&input.tool, "tool")?;
        let tool_call_id = normalize_required_text(&input.tool_call_id, "toolCallId")?;
        let mutation_intent =
            validate_choice(&input.mutation_intent, &MUTATION_INTENTS, "mutationIntent")?;
        let paths = normalize_paths(&input.paths)?;
        let index = active_todo_index(items)?;
        let item = items.get_mut(index).unwrap();
        let seq = item
            .mutation_log
            .last()
            .map(|entry| entry.seq + 1)
            .unwrap_or(1);
        item.mutation_log.push(TodoMutationLogEntry {
            seq,
            tool,
            turn: input.turn,
            actor,
            paths,
            mutation_intent,
            tool_call_id,
        });
        recompute_files_touched(item);
        item.last_touched_turn = input.turn;
        let item_snapshot = item.clone();
        Ok(build_response(items, Some(&item_snapshot), false))
    });
    if let Ok(response) = &result {
        emit_todo_changed(
            &app_handle,
            &TodoChangeEvent {
                session_id: session_id,
                todo_id: response.item.as_ref().map(|item| item.id.clone()),
                change: "mutation".to_string(),
                changed_at: now_ms(),
            },
        );
    }
    result
}

#[tauri::command]
pub fn todo_store_context_enrich(
    session_id: String,
    input: TodoContextEnrichmentInput,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<TodoMutationResponse, String> {
    let start = Instant::now();
    tool_log(
        "todo_store_context_enrich",
        "start",
        json!({ "sessionId": session_id, "updateCount": input.updates.len() }),
    );
    let result = mutate_todos(&session_id, &state, |items| {
        let mut seen_todo_ids = HashSet::new();
        let mut touched_ids = HashSet::new();

        for update in &input.updates {
            let todo_id = normalize_required_text(&update.todo_id, "todoId")?;
            if !seen_todo_ids.insert(todo_id.clone()) {
                return Err(format!(
                    "INVALID_ARGUMENT: duplicate todoId {} in context enrichment",
                    todo_id
                ));
            }

            let index = items
                .iter()
                .position(|item| item.id == todo_id)
                .ok_or_else(|| format!("NOT_FOUND: Todo {} not found", todo_id))?;
            let item = items.get_mut(index).unwrap();

            let learned_changed = apply_note_enrichment(
                &mut item.things_learned,
                &update.verify_things_learned_note_ids,
                &update.append_things_learned,
                &update.remove_duplicate_things_learned_note_ids,
                "thingsLearned",
                input.turn,
            )?;
            let critical_changed = apply_note_enrichment(
                &mut item.critical_info,
                &update.verify_critical_info_note_ids,
                &update.append_critical_info,
                &update.remove_duplicate_critical_info_note_ids,
                "criticalInfo",
                input.turn,
            )?;

            if learned_changed || critical_changed {
                item.last_touched_turn = input.turn;
                touched_ids.insert(item.id.clone());
            }
        }

        Ok(build_response(items, None, !touched_ids.is_empty()))
    });

    match &result {
        Ok(response) => {
            if response.removed {
                emit_todo_changed(
                    &app_handle,
                    &TodoChangeEvent {
                        session_id: session_id.clone(),
                        todo_id: None,
                        change: "context_enriched".to_string(),
                        changed_at: now_ms(),
                    },
                );
            }
            tool_log(
                "todo_store_context_enrich",
                "ok",
                json!({
                    "sessionId": session_id,
                    "changed": response.removed,
                    "durationMs": start.elapsed().as_millis() as u64
                }),
            );
        }
        Err(error) => tool_log(
            "todo_store_context_enrich",
            "err",
            json!({ "sessionId": session_id, "error": error, "durationMs": start.elapsed().as_millis() as u64 }),
        ),
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_todo(id: &str, state: &str) -> TodoItem {
        TodoItem {
            id: id.to_string(),
            title: format!("Todo {}", id),
            state: state.to_string(),
            owner: "main".to_string(),
            created_turn: 1,
            updated_turn: 1,
            last_touched_turn: 1,
            files_touched: Vec::new(),
            things_learned: Vec::new(),
            critical_info: Vec::new(),
            mutation_log: Vec::new(),
            completion_note: None,
        }
    }

    fn make_note(id: &str, text: &str, verified: bool) -> TodoNoteItem {
        TodoNoteItem {
            id: id.to_string(),
            text: text.to_string(),
            added_turn: 1,
            author: "main".to_string(),
            source: "agent".to_string(),
            verified,
        }
    }

    #[test]
    fn test_normalize_paths_rejects_invalid_entries_and_dedupes() {
        assert_eq!(
            normalize_paths(&vec![
                "src/agent/types.ts".to_string(),
                "src\\agent\\types.ts".to_string(),
            ])
            .unwrap(),
            vec!["src/agent/types.ts".to_string()]
        );
        assert!(normalize_paths(&vec!["../escape".to_string()]).is_err());
        assert!(normalize_paths(&vec!["/absolute".to_string()]).is_err());
    }

    #[test]
    fn test_active_todo_index_requires_exactly_one_doing_todo() {
        assert_eq!(
            active_todo_index(&vec![make_todo("a", "todo"), make_todo("b", "doing")]).unwrap(),
            1
        );
        assert!(active_todo_index(&vec![make_todo("a", "todo")]).is_err());
        assert!(
            active_todo_index(&vec![make_todo("a", "doing"), make_todo("b", "doing")]).is_err()
        );
    }

    #[test]
    fn test_enforce_single_doing_only_blocks_conflicting_candidates() {
        let items = vec![make_todo("a", "doing"), make_todo("b", "todo")];
        assert!(enforce_single_doing(&items, "a", "doing").is_ok());
        assert!(enforce_single_doing(&items, "b", "todo").is_ok());
        assert!(enforce_single_doing(&items, "b", "doing").is_err());
    }

    #[test]
    fn test_recompute_files_touched_projects_unique_paths_from_mutation_log() {
        let mut item = make_todo("a", "doing");
        item.mutation_log = vec![
            TodoMutationLogEntry {
                seq: 1,
                tool: "workspace_writeFile".to_string(),
                turn: 2,
                actor: "main".to_string(),
                paths: vec!["src/agent/types.ts".to_string()],
                mutation_intent: "implementation".to_string(),
                tool_call_id: "tc-1".to_string(),
            },
            TodoMutationLogEntry {
                seq: 2,
                tool: "exec_run".to_string(),
                turn: 3,
                actor: "planner".to_string(),
                paths: vec![
                    "src/agent/types.ts".to_string(),
                    "src/agent/runner.ts".to_string(),
                ],
                mutation_intent: "test".to_string(),
                tool_call_id: "tc-2".to_string(),
            },
        ];

        recompute_files_touched(&mut item);

        assert_eq!(
            item.files_touched,
            vec![
                "src/agent/types.ts".to_string(),
                "src/agent/runner.ts".to_string()
            ]
        );
    }

    #[test]
    fn test_apply_note_enrichment_verifies_appends_and_dedupes_near_exact_duplicates() {
        let mut notes = vec![
            make_note("note-1", "Preserve the leading system prompt.", false),
            make_note("note-2", "  preserve   the leading system prompt! ", false),
        ];

        let changed = apply_note_enrichment(
            &mut notes,
            &vec!["note-1".to_string()],
            &vec![
                "The compactor replaces apiMessages but keeps chatMessages.".to_string(),
                "the compactor replaces apiMessages but keeps chatMessages!".to_string(),
            ],
            &vec!["note-2".to_string()],
            "thingsLearned",
            7,
        )
        .unwrap();

        assert!(changed);
        assert_eq!(notes.len(), 2);
        assert!(notes[0].verified);
        assert_eq!(notes[1].source, "context_gateway".to_string());
        assert!(notes[1].verified);
        assert_eq!(
            notes[1].text,
            "The compactor replaces apiMessages but keeps chatMessages."
        );
    }

    #[test]
    fn test_apply_note_enrichment_rejects_non_duplicate_removal() {
        let mut notes = vec![
            make_note("note-1", "First fact", false),
            make_note("note-2", "Second fact", false),
        ];

        let error = apply_note_enrichment(
            &mut notes,
            &Vec::new(),
            &Vec::new(),
            &vec!["note-2".to_string()],
            "criticalInfo",
            7,
        )
        .unwrap_err();

        assert!(error.contains("not a later exact/near-exact duplicate"));
        assert_eq!(notes.len(), 2);
    }
}
