use crate::shell_env::resolved_login_shell_env;
use crate::utils::tool_log;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const CODEX_SESSION_EVENT: &str = "codex_session_event";

type SharedChild = Arc<Mutex<Child>>;
type SharedStdin = Arc<Mutex<ChildStdin>>;
type PendingRequests = Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>;
type SharedRuntimeState = Arc<Mutex<CodexRuntimeState>>;

#[derive(Default)]
struct CodexRuntimeState {
    thread_id: Option<String>,
    turn_id: Option<String>,
}

#[derive(Clone)]
struct CodexRuntime {
    child: SharedChild,
    stdin: SharedStdin,
    pending: PendingRequests,
    state: SharedRuntimeState,
}

static CODEX_RUNTIMES: OnceLock<Mutex<HashMap<String, CodexRuntime>>> = OnceLock::new();

fn codex_runtimes() -> &'static Mutex<HashMap<String, CodexRuntime>> {
    CODEX_RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub available: bool,
    pub version: Option<String>,
    pub command_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionStartResult {
    pub runtime_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionSendTurnInput {
    pub runtime_id: String,
    pub cwd: String,
    pub prompt: String,
    pub profile_prompt: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeInput {
    pub runtime_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionSendTurnResult {
    pub thread_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexSessionEventPayload {
    runtime_id: String,
    event: Value,
}

fn command_uses_explicit_path(command: &str) -> bool {
    command.contains(std::path::MAIN_SEPARATOR)
        || command.contains('/')
        || command.contains('\\')
        || Path::new(command).is_absolute()
}

#[cfg(windows)]
fn candidate_windows_extensions() -> Vec<String> {
    std::env::var("PATHEXT")
        .ok()
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter_map(|ext| {
            let trimmed = ext.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.starts_with('.') {
                Some(trimmed.to_string())
            } else {
                Some(format!(".{}", trimmed))
            }
        })
        .collect()
}

fn resolve_command_from_path(command: &str, path_env: Option<&str>) -> Option<PathBuf> {
    if command_uses_explicit_path(command) {
        return Some(PathBuf::from(command));
    }

    let path_env = path_env?;
    for dir in std::env::split_paths(path_env) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }

        #[cfg(windows)]
        if candidate.extension().is_none() {
            for ext in candidate_windows_extensions() {
                let candidate_with_ext = candidate.with_extension(ext.trim_start_matches('.'));
                if candidate_with_ext.is_file() {
                    return Some(candidate_with_ext);
                }
            }
        }
    }

    None
}

fn codex_command_path() -> Option<PathBuf> {
    let shell_env = resolved_login_shell_env();
    let effective_path = shell_env
        .path
        .clone()
        .or_else(|| std::env::var("PATH").ok());
    resolve_command_from_path("codex", effective_path.as_deref())
}

fn apply_shell_env(cmd: &mut Command) {
    let shell_env = resolved_login_shell_env();
    if let Some(path) = shell_env.path.as_deref() {
        cmd.env("PATH", path);
    }
    if let Some(shell) = shell_env.shell.as_deref() {
        cmd.env("SHELL", shell);
    }
    if let Some(lang) = shell_env.lang.as_deref() {
        cmd.env("LANG", lang);
    }
    if let Some(lc_all) = shell_env.lc_all.as_deref() {
        cmd.env("LC_ALL", lc_all);
    }
    if let Some(lc_ctype) = shell_env.lc_ctype.as_deref() {
        cmd.env("LC_CTYPE", lc_ctype);
    }
}

fn response_id_key(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn emit_codex_event(app_handle: &AppHandle, runtime_id: &str, event: Value) {
    let _ = app_handle.emit(
        CODEX_SESSION_EVENT,
        CodexSessionEventPayload {
            runtime_id: runtime_id.to_string(),
            event,
        },
    );
}

fn remove_runtime(runtime_id: &str) {
    codex_runtimes().lock().unwrap().remove(runtime_id);
}

fn update_runtime_from_event(state: &SharedRuntimeState, value: &Value) {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = value.get("params").and_then(Value::as_object);

    match method {
        "thread/started" => {
            let next_thread_id = params
                .and_then(|params| params.get("thread"))
                .and_then(Value::as_object)
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if let Some(thread_id) = next_thread_id {
                state.lock().unwrap().thread_id = Some(thread_id);
            }
        }
        "turn/started" => {
            let next_turn_id = params
                .and_then(|params| params.get("turn"))
                .and_then(Value::as_object)
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .map(ToString::to_string);
            if let Some(turn_id) = next_turn_id {
                state.lock().unwrap().turn_id = Some(turn_id);
            }
        }
        "turn/completed" => {
            state.lock().unwrap().turn_id = None;
        }
        _ => {}
    }
}

fn spawn_stdout_reader(
    runtime_id: String,
    stdout: ChildStdout,
    pending: PendingRequests,
    state: SharedRuntimeState,
    app_handle: AppHandle,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            match serde_json::from_str::<Value>(trimmed) {
                Ok(value) => {
                    if let Some(id) = value.get("id").and_then(response_id_key) {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(value);
                            continue;
                        }
                    }
                    update_runtime_from_event(&state, &value);
                    emit_codex_event(&app_handle, &runtime_id, value);
                }
                Err(error) => emit_codex_event(
                    &app_handle,
                    &runtime_id,
                    json!({
                        "type": "runtime_parse_error",
                        "message": error.to_string(),
                        "raw": trimmed,
                    }),
                ),
            }
        }
    });
}

fn spawn_stderr_reader(runtime_id: String, stderr: ChildStderr, app_handle: AppHandle) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            emit_codex_event(
                &app_handle,
                &runtime_id,
                json!({
                    "type": "runtime_stderr",
                    "message": trimmed,
                }),
            );
        }
    });
}

fn spawn_waiter(runtime_id: String, child: SharedChild, app_handle: AppHandle) {
    std::thread::spawn(move || {
        let exit = child.lock().unwrap().wait();
        remove_runtime(&runtime_id);
        match exit {
            Ok(status) => emit_codex_event(
                &app_handle,
                &runtime_id,
                json!({
                    "type": "runtime_exit",
                    "exitCode": status.code(),
                }),
            ),
            Err(error) => emit_codex_event(
                &app_handle,
                &runtime_id,
                json!({
                    "type": "runtime_exit",
                    "exitCode": Value::Null,
                    "error": error.to_string(),
                }),
            ),
        }
    });
}

fn runtime_for_id(runtime_id: &str) -> Result<CodexRuntime, String> {
    codex_runtimes()
        .lock()
        .unwrap()
        .get(runtime_id)
        .cloned()
        .ok_or_else(|| "Codex runtime not found".to_string())
}

fn send_json_line(stdin: &SharedStdin, value: &Value) -> Result<(), String> {
    let mut payload =
        serde_json::to_vec(value).map_err(|error| format!("Failed to encode request: {error}"))?;
    payload.push(b'\n');
    let mut stdin = stdin.lock().unwrap();
    stdin
        .write_all(&payload)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to write Codex request: {error}"))
}

fn send_request(runtime_id: &str, method: &str, params: Value) -> Result<Value, String> {
    let runtime = runtime_for_id(runtime_id)?;
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    runtime
        .pending
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);
    let request = json!({
        "id": request_id,
        "method": method,
        "params": params,
    });

    if let Err(error) = send_json_line(&runtime.stdin, &request) {
        runtime.pending.lock().unwrap().remove(&request_id);
        return Err(error);
    }

    let response = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| format!("Timed out waiting for Codex response to {method}"))?;
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| error.to_string());
        return Err(message);
    }
    Ok(response)
}

fn send_notification(runtime_id: &str, method: &str, params: Option<Value>) -> Result<(), String> {
    let runtime = runtime_for_id(runtime_id)?;
    let payload = match params {
        Some(params) => json!({
            "method": method,
            "params": params,
        }),
        None => json!({
            "method": method,
        }),
    };
    send_json_line(&runtime.stdin, &payload)
}

fn extract_thread_id(response: &Value) -> Option<String> {
    response
        .get("result")
        .and_then(|result| result.get("thread"))
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_turn_id(response: &Value) -> Option<String> {
    response
        .get("result")
        .and_then(|result| result.get("turn"))
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[tauri::command]
pub fn codex_get_status() -> Result<CodexStatus, String> {
    let Some(command_path) = codex_command_path() else {
        return Ok(CodexStatus {
            available: false,
            version: None,
            command_path: None,
            error: Some("Codex CLI was not found in PATH.".to_string()),
        });
    };

    let mut cmd = Command::new(&command_path);
    cmd.arg("--version");
    apply_shell_env(&mut cmd);
    match cmd.output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty());
            Ok(CodexStatus {
                available: output.status.success(),
                version,
                command_path: Some(command_path.to_string_lossy().to_string()),
                error: if output.status.success() {
                    None
                } else {
                    Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
                },
            })
        }
        Err(error) => Ok(CodexStatus {
            available: false,
            version: None,
            command_path: Some(command_path.to_string_lossy().to_string()),
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub fn codex_session_start(app_handle: AppHandle) -> Result<CodexSessionStartResult, String> {
    let command_path = codex_command_path()
        .ok_or_else(|| "Codex CLI was not found in PATH.".to_string())?;

    let mut cmd = Command::new(&command_path);
    cmd.args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_shell_env(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Failed to start Codex app-server: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin was unavailable.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable.".to_string())?;

    let runtime_id = Uuid::new_v4().to_string();
    let shared_child = Arc::new(Mutex::new(child));
    let shared_stdin = Arc::new(Mutex::new(stdin));
    let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let state: SharedRuntimeState = Arc::new(Mutex::new(CodexRuntimeState::default()));

    codex_runtimes().lock().unwrap().insert(
        runtime_id.clone(),
        CodexRuntime {
            child: Arc::clone(&shared_child),
            stdin: Arc::clone(&shared_stdin),
            pending: Arc::clone(&pending),
            state: Arc::clone(&state),
        },
    );

    spawn_stdout_reader(
        runtime_id.clone(),
        stdout,
        Arc::clone(&pending),
        Arc::clone(&state),
        app_handle.clone(),
    );
    spawn_stderr_reader(runtime_id.clone(), stderr, app_handle.clone());
    spawn_waiter(runtime_id.clone(), Arc::clone(&shared_child), app_handle);

    let initialize = send_request(
        &runtime_id,
        "initialize",
        json!({
            "clientInfo": {
                "name": "rakh",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "experimentalApi": true,
            }
        }),
    );
    if let Err(error) = initialize {
        let _ = codex_session_close(CodexRuntimeInput {
            runtime_id: runtime_id.clone(),
        });
        return Err(error);
    }

    if let Err(error) = send_notification(&runtime_id, "initialized", None) {
        let _ = codex_session_close(CodexRuntimeInput {
            runtime_id: runtime_id.clone(),
        });
        return Err(error);
    }

    tool_log(
        "codex_session_start",
        "ok",
        json!({
            "runtimeId": runtime_id,
            "commandPath": command_path.to_string_lossy().to_string(),
        }),
    );

    Ok(CodexSessionStartResult { runtime_id })
}

#[tauri::command]
pub fn codex_session_send_turn(
    input: CodexSessionSendTurnInput,
) -> Result<CodexSessionSendTurnResult, String> {
    let normalized_thread_id = input.thread_id.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    let thread_id = if let Some(thread_id) = normalized_thread_id {
        thread_id
    } else {
        let response = send_request(
            &input.runtime_id,
            "thread/start",
            json!({
                "cwd": input.cwd,
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "personality": "pragmatic",
                "developerInstructions": input.profile_prompt,
            }),
        )?;
        extract_thread_id(&response)
            .ok_or_else(|| "Codex thread/start response did not include a thread id.".to_string())?
    };

    let turn_response = send_request(
        &input.runtime_id,
        "turn/start",
        json!({
            "threadId": thread_id,
            "cwd": input.cwd,
            "approvalPolicy": "never",
            "input": [
                {
                    "type": "text",
                    "text": input.prompt,
                }
            ],
        }),
    )?;

    let runtime = runtime_for_id(&input.runtime_id)?;
    let mut runtime_state = runtime.state.lock().unwrap();
    runtime_state.thread_id = Some(thread_id.clone());
    runtime_state.turn_id = extract_turn_id(&turn_response);

    Ok(CodexSessionSendTurnResult {
        thread_id: Some(thread_id),
    })
}

#[tauri::command]
pub fn codex_session_interrupt(input: CodexRuntimeInput) -> Result<(), String> {
    let runtime = runtime_for_id(&input.runtime_id)?;
    let (thread_id, turn_id) = {
        let state = runtime.state.lock().unwrap();
        (state.thread_id.clone(), state.turn_id.clone())
    };

    let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else {
        return Ok(());
    };

    send_request(
        &input.runtime_id,
        "turn/interrupt",
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
        }),
    )?;
    Ok(())
}

#[tauri::command]
pub fn codex_session_close(input: CodexRuntimeInput) -> Result<(), String> {
    let runtime = runtime_for_id(&input.runtime_id)?;
    let _ = runtime.child.lock().unwrap().kill();
    remove_runtime(&input.runtime_id);
    Ok(())
}
