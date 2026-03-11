use crate::shell_env::resolved_login_shell_env;
use crate::utils::{tool_log, truncate_bytes};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use vte::{Parser, Perform};

pub type SharedExecChild = Arc<Mutex<std::process::Child>>;

static RUNNING_EXEC_CHILDREN: OnceLock<Mutex<HashMap<String, SharedExecChild>>> = OnceLock::new();
static ABORTED_EXEC_RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static STOPPED_EXEC_RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn running_exec_children() -> &'static Mutex<HashMap<String, SharedExecChild>> {
    RUNNING_EXEC_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn aborted_exec_runs() -> &'static Mutex<HashSet<String>> {
    ABORTED_EXEC_RUNS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn stopped_exec_runs() -> &'static Mutex<HashSet<String>> {
    STOPPED_EXEC_RUNS.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Default)]
struct PlainTextExecOutput {
    bytes: Vec<u8>,
    pending_carriage_return: bool,
}

impl PlainTextExecOutput {
    fn flush_pending_carriage_return(&mut self) {
        if self.pending_carriage_return {
            self.bytes.push(b'\n');
            self.pending_carriage_return = false;
        }
    }

    fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }

    fn finish(mut self) -> Vec<u8> {
        self.flush_pending_carriage_return();
        self.bytes
    }
}

impl Perform for PlainTextExecOutput {
    fn print(&mut self, c: char) {
        self.flush_pending_carriage_return();
        let mut utf8 = [0u8; 4];
        self.bytes
            .extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => {
                self.pending_carriage_return = false;
                self.bytes.push(b'\n');
            }
            b'\r' => {
                self.pending_carriage_return = true;
            }
            b'\t' => {
                self.flush_pending_carriage_return();
                self.bytes.push(b'\t');
            }
            _ => {
                self.flush_pending_carriage_return();
            }
        }
    }
}

#[derive(Default)]
struct ExecOutputSanitizer {
    parser: Parser,
    plain_text: PlainTextExecOutput,
}

impl ExecOutputSanitizer {
    fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.parser.advance(&mut self.plain_text, bytes);
        self.plain_text.take_bytes()
    }

    fn finish(self) -> Vec<u8> {
        self.plain_text.finish()
    }
}

fn sanitize_exec_output_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut sanitizer = ExecOutputSanitizer::default();
    let mut output = sanitizer.push(bytes);
    output.extend(sanitizer.finish());
    output
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

pub async fn exec_run_inner(
    app: Option<AppHandle>,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: std::collections::HashMap<String, String>,
    timeout_ms: u64,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    stdin: Option<String>,
    run_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let start = Instant::now();
        let shell_env = resolved_login_shell_env();
        let effective_path = env
            .get("PATH")
            .cloned()
            .or_else(|| shell_env.path.clone())
            .or_else(|| std::env::var("PATH").ok());
        let resolved_program = resolve_command_from_path(&command, effective_path.as_deref());

        let cwd_exists = std::path::Path::new(&cwd).exists();
        let path_env = effective_path.unwrap_or_else(|| "<not set>".to_string());
        let resolved_bin = resolved_program
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "<not found in PATH>".to_string());

        let env_keys: Vec<String> = env.keys().cloned().collect();

        tool_log(
            "exec_run",
            "start",
            json!({
                "command": command,
                "args": args,
                "cwd": cwd,
                "cwdExists": cwd_exists,
                "timeoutMs": timeout_ms,
                "maxStdoutBytes": max_stdout_bytes,
                "maxStderrBytes": max_stderr_bytes,
                "stdinBytes": stdin.as_ref().map(|s| s.as_bytes().len()).unwrap_or(0),
                "envKeys": env_keys,
                "resolvedBin": resolved_bin,
                "path": path_env
            }),
        );

        if !command_uses_explicit_path(&command) && resolved_program.is_none() {
            let msg = if !cwd_exists {
                format!("Command failed to start: cwd does not exist: {}", cwd)
            } else {
                format!("Command failed to start: {:?} not found in PATH", command)
            };

            tool_log(
                "exec_run",
                "err",
                json!({
                    "durationMs": start.elapsed().as_millis() as u64,
                    "error": msg,
                    "ioErrorKind": format!("{:?}", std::io::ErrorKind::NotFound),
                    "cwdExists": cwd_exists
                }),
            );

            return Err(msg);
        }

        let mut cmd = std::process::Command::new(
            resolved_program
                .as_ref()
                .unwrap_or(&PathBuf::from(&command)),
        );
        cmd.args(&args)
            .current_dir(&cwd)
            .envs(&env)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if !env.contains_key("PATH") {
            if let Some(path) = shell_env.path.as_deref() {
                cmd.env("PATH", path);
            }
        }
        if !env.contains_key("SHELL") {
            if let Some(shell) = shell_env.shell.as_deref() {
                cmd.env("SHELL", shell);
            }
        }
        if !env.contains_key("LANG") {
            if let Some(lang) = shell_env.lang.as_deref() {
                cmd.env("LANG", lang);
            }
        }
        if !env.contains_key("LC_ALL") {
            if let Some(lc_all) = shell_env.lc_all.as_deref() {
                cmd.env("LC_ALL", lc_all);
            }
        }
        if !env.contains_key("LC_CTYPE") {
            if let Some(lc_ctype) = shell_env.lc_ctype.as_deref() {
                cmd.env("LC_CTYPE", lc_ctype);
            }
        }
        if stdin.is_some() {
            cmd.stdin(std::process::Stdio::piped());
        }

        let mut child = cmd.spawn().map_err(|e| {
            let kind = e.kind();
            let msg = if kind == std::io::ErrorKind::NotFound {
                if !cwd_exists {
                    format!("Command failed to start: cwd does not exist: {}", cwd)
                } else {
                    format!("Command failed to start: {:?} not found in PATH", command)
                }
            } else {
                format!("Command failed to start: {}", e)
            };

            tool_log(
                "exec_run",
                "err",
                json!({
                    "durationMs": start.elapsed().as_millis() as u64,
                    "error": msg,
                    "ioErrorKind": format!("{:?}", kind),
                    "cwdExists": cwd_exists
                }),
            );

            msg
        })?;

        if let Some(input) = stdin {
            if let Some(mut child_stdin) = child.stdin.take() {
                child_stdin
                    .write_all(input.as_bytes())
                    .map_err(|e| format!("Failed to write stdin: {}", e))?;
            }
        }

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let app_out = app.clone();
        let run_id_out = run_id.clone();
        let stdout_reader = std::thread::spawn(move || -> Vec<u8> {
            let mut full_buf = Vec::new();
            let mut sanitizer = ExecOutputSanitizer::default();
            if let Some(mut out) = stdout_pipe {
                let mut chunk = [0u8; 4096];
                loop {
                    match out.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = &chunk[..n];
                            full_buf.extend_from_slice(data);
                            if let (Some(ref app_h), Some(ref id)) = (&app_out, &run_id_out) {
                                let sanitized = sanitizer.push(data);
                                if !sanitized.is_empty() {
                                    let s = String::from_utf8_lossy(&sanitized);
                                    let _ = app_h.emit(
                                        "exec_output",
                                        json!({
                                            "runId": id,
                                            "stream": "stdout",
                                            "data": s.as_ref(),
                                        }),
                                    );
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            if let (Some(ref app_h), Some(ref id)) = (&app_out, &run_id_out) {
                let tail = sanitizer.finish();
                if !tail.is_empty() {
                    let s = String::from_utf8_lossy(&tail);
                    let _ = app_h.emit(
                        "exec_output",
                        json!({
                            "runId": id,
                            "stream": "stdout",
                            "data": s.as_ref(),
                        }),
                    );
                }
            }
            full_buf
        });

        let app_err = app.clone();
        let run_id_err = run_id.clone();
        let stderr_reader = std::thread::spawn(move || -> Vec<u8> {
            let mut full_buf = Vec::new();
            let mut sanitizer = ExecOutputSanitizer::default();
            if let Some(mut err) = stderr_pipe {
                let mut chunk = [0u8; 4096];
                loop {
                    match err.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = &chunk[..n];
                            full_buf.extend_from_slice(data);
                            if let (Some(ref app_h), Some(ref id)) = (&app_err, &run_id_err) {
                                let sanitized = sanitizer.push(data);
                                if !sanitized.is_empty() {
                                    let s = String::from_utf8_lossy(&sanitized);
                                    let _ = app_h.emit(
                                        "exec_output",
                                        json!({
                                            "runId": id,
                                            "stream": "stderr",
                                            "data": s.as_ref(),
                                        }),
                                    );
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
            if let (Some(ref app_h), Some(ref id)) = (&app_err, &run_id_err) {
                let tail = sanitizer.finish();
                if !tail.is_empty() {
                    let s = String::from_utf8_lossy(&tail);
                    let _ = app_h.emit(
                        "exec_output",
                        json!({
                            "runId": id,
                            "stream": "stderr",
                            "data": s.as_ref(),
                        }),
                    );
                }
            }
            full_buf
        });

        let child_handle: SharedExecChild = Arc::new(Mutex::new(child));
        if let Some(ref id) = run_id {
            running_exec_children()
                .lock()
                .unwrap()
                .insert(id.clone(), child_handle.clone());
        }

        let timeout = Duration::from_millis(timeout_ms);
        let mut status_opt: Option<std::process::ExitStatus> = None;
        let mut timed_out = false;

        loop {
            {
                let mut locked_child = child_handle.lock().unwrap();
                match locked_child.try_wait() {
                    Ok(Some(status)) => {
                        status_opt = Some(status);
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => return Err(format!("Command wait failed: {}", e)),
                }
            }

            if start.elapsed() >= timeout {
                let mut locked_child = child_handle.lock().unwrap();
                let _ = locked_child.kill();
                let _ = locked_child.wait();
                timed_out = true;
                break;
            }

            std::thread::sleep(Duration::from_millis(20));
        }

        let mut terminated_by_user = false;
        if let Some(ref id) = run_id {
            running_exec_children().lock().unwrap().remove(id);
            if aborted_exec_runs().lock().unwrap().remove(id) {
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("ABORTED".to_string());
            }
            terminated_by_user = stopped_exec_runs().lock().unwrap().remove(id);
        }

        if timed_out {
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err("TIMEOUT".to_string());
        }

        let status = status_opt.ok_or_else(|| "Command exited without status".to_string())?;
        let exit_code = status.code().unwrap_or(-1);
        let duration_ms = start.elapsed().as_millis() as u64;

        let stdout_raw = stdout_reader.join().unwrap_or_default();
        let stderr_raw = stderr_reader.join().unwrap_or_default();
        let stdout_sanitized = sanitize_exec_output_bytes(&stdout_raw);
        let stderr_sanitized = sanitize_exec_output_bytes(&stderr_raw);
        let (stdout_trimmed, trunc_out) = truncate_bytes(&stdout_sanitized, max_stdout_bytes);
        let (stderr_trimmed, trunc_err) = truncate_bytes(&stderr_sanitized, max_stderr_bytes);

        let result = json!({
            "command": command,
            "args": args,
            "cwd": cwd,
            "exitCode": exit_code,
            "durationMs": duration_ms,
            "stdout": String::from_utf8_lossy(&stdout_trimmed).to_string(),
            "stderr": String::from_utf8_lossy(&stderr_trimmed).to_string(),
            "truncatedStdout": trunc_out,
            "truncatedStderr": trunc_err,
            "terminatedByUser": terminated_by_user,
        });

        tool_log(
            "exec_run",
            "ok",
            json!({
                "durationMs": duration_ms,
                "exitCode": exit_code,
                "stdoutBytes": stdout_raw.len(),
                "stderrBytes": stderr_raw.len(),
                "truncatedStdout": trunc_out,
                "truncatedStderr": trunc_err,
                "terminatedByUser": terminated_by_user
            }),
        );

        Ok(result)
    })
    .await
    .map_err(|e| format!("Command execution failed: {}", e))?
}

#[tauri::command]
pub async fn exec_run(
    app: AppHandle,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: std::collections::HashMap<String, String>,
    timeout_ms: u64,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    stdin: Option<String>,
    run_id: Option<String>,
) -> Result<Value, String> {
    exec_run_inner(
        Some(app),
        command,
        args,
        cwd,
        env,
        timeout_ms,
        max_stdout_bytes,
        max_stderr_bytes,
        stdin,
        run_id,
    )
    .await
}

#[tauri::command]
pub fn exec_abort(run_id: String) -> Result<Value, String> {
    let start = Instant::now();
    tool_log("exec_abort", "start", json!({ "runId": run_id }));

    let result: Result<Value, String> = (|| {
        let maybe_child = running_exec_children().lock().unwrap().remove(&run_id);

        if let Some(child_handle) = maybe_child {
            let mut child = child_handle.lock().unwrap();
            match child.try_wait() {
                Ok(Some(_)) => {
                    return Ok(json!({ "aborted": false, "alreadyExited": true }));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("Failed to check process state: {}", e)),
            };

            let killed = match child.kill() {
                Ok(_) => true,
                Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => false,
                Err(e) => return Err(format!("Failed to abort command: {}", e)),
            };

            let _ = child.wait();

            if killed {
                aborted_exec_runs().lock().unwrap().insert(run_id);
                return Ok(json!({ "aborted": true }));
            }

            return Ok(json!({ "aborted": false, "alreadyExited": true }));
        }

        Ok(json!({ "aborted": false }))
    })();

    match &result {
        Ok(v) => tool_log(
            "exec_abort",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "aborted": v["aborted"],
                "alreadyExited": v.get("alreadyExited").cloned().unwrap_or(json!(null))
            }),
        ),
        Err(e) => tool_log(
            "exec_abort",
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
pub fn exec_stop(run_id: String) -> Result<Value, String> {
    let start = Instant::now();
    tool_log("exec_stop", "start", json!({ "runId": run_id }));

    let result: Result<Value, String> = (|| {
        let maybe_child = running_exec_children().lock().unwrap().remove(&run_id);

        if let Some(child_handle) = maybe_child {
            let mut child = child_handle.lock().unwrap();
            match child.try_wait() {
                Ok(Some(_)) => {
                    return Ok(json!({ "stopped": false, "alreadyExited": true }));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("Failed to check process state: {}", e)),
            };

            let killed = match child.kill() {
                Ok(_) => true,
                Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => false,
                Err(e) => return Err(format!("Failed to stop command: {}", e)),
            };

            let _ = child.wait();

            if killed {
                aborted_exec_runs().lock().unwrap().remove(&run_id);
                stopped_exec_runs().lock().unwrap().insert(run_id);
                return Ok(json!({ "stopped": true }));
            }

            return Ok(json!({ "stopped": false, "alreadyExited": true }));
        }

        Ok(json!({ "stopped": false }))
    })();

    match &result {
        Ok(v) => tool_log(
            "exec_stop",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "stopped": v["stopped"],
                "alreadyExited": v.get("alreadyExited").cloned().unwrap_or(json!(null))
            }),
        ),
        Err(e) => tool_log(
            "exec_stop",
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
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn test_exec_run() {
        let dir = tempdir().unwrap();
        let path_str = dir.path().to_string_lossy().to_string();

        #[cfg(unix)]
        let (success_cmd, success_args, fail_cmd, fail_args, timeout_cmd, timeout_args) = (
            "sh".to_string(),
            vec!["-c".to_string(), "printf 'hello world\\n'".to_string()],
            "sh".to_string(),
            vec!["-c".to_string(), "exit 42".to_string()],
            "sh".to_string(),
            vec!["-c".to_string(), "sleep 2".to_string()],
        );

        #[cfg(windows)]
        let (success_cmd, success_args, fail_cmd, fail_args, timeout_cmd, timeout_args) = (
            "cmd".to_string(),
            vec!["/C".to_string(), "echo hello world".to_string()],
            "cmd".to_string(),
            vec!["/C".to_string(), "exit /B 42".to_string()],
            "cmd".to_string(),
            vec!["/C".to_string(), "ping -n 3 127.0.0.1 > nul".to_string()],
        );

        // 1. Successful execution
        let res = tauri::async_runtime::block_on(exec_run_inner(
            None,
            success_cmd,
            success_args,
            path_str.clone(),
            std::collections::HashMap::new(),
            5000,
            1024,
            1024,
            None,
            None,
        ))
        .unwrap();
        assert_eq!(res["exitCode"], 0);
        assert_eq!(res["stdout"].as_str().unwrap().trim(), "hello world");
        assert_eq!(res["stderr"], "");

        // 2. Failed execution (command returns non-zero)
        let fail_res = tauri::async_runtime::block_on(exec_run_inner(
            None,
            fail_cmd,
            fail_args,
            path_str.clone(),
            std::collections::HashMap::new(),
            5000,
            1024,
            1024,
            None,
            None,
        ))
        .unwrap();
        assert_eq!(fail_res["exitCode"], 42);

        // 3. Timeout execution
        let timeout_res = tauri::async_runtime::block_on(exec_run_inner(
            None,
            timeout_cmd,
            timeout_args,
            path_str.clone(),
            std::collections::HashMap::new(),
            100,
            1024,
            1024,
            None,
            None,
        ));
        assert!(timeout_res.is_err());
        assert_eq!(timeout_res.unwrap_err(), "TIMEOUT");

        let missing_abort = exec_abort("missing-run-id".to_string()).unwrap();
        assert_eq!(missing_abort["aborted"], false);

        let missing_stop = exec_stop("missing-run-id".to_string()).unwrap();
        assert_eq!(missing_stop["stopped"], false);
    }

    #[test]
    fn test_resolve_command_from_path_finds_executable() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("custom-bin");
        fs::write(&file_path, b"#!/bin/sh\n").unwrap();

        #[cfg(unix)]
        {
            let mut perms = fs::metadata(&file_path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&file_path, perms).unwrap();
        }

        let resolved =
            resolve_command_from_path("custom-bin", Some(dir.path().to_string_lossy().as_ref()))
                .unwrap();

        assert_eq!(resolved, file_path);
    }

    #[test]
    fn test_sanitize_exec_output_bytes_strips_ansi_sequences() {
        let sanitized = sanitize_exec_output_bytes(
            b"\x1b[33mWarning\x1b[0m\n\x1b[3mnpm:fsevents@2.3.3\x1b[0m\n",
        );

        assert_eq!(
            String::from_utf8(sanitized).unwrap(),
            "Warning\nnpm:fsevents@2.3.3\n"
        );
    }

    #[test]
    fn test_exec_output_sanitizer_handles_split_escape_sequences() {
        let mut sanitizer = ExecOutputSanitizer::default();

        assert_eq!(sanitizer.push(b"\x1b[3"), b"");
        assert_eq!(sanitizer.push(b"3mWarn"), b"Warn");
        assert_eq!(sanitizer.push(b"ing\x1b[0"), b"ing");
        assert_eq!(sanitizer.push(b"m\n"), b"\n");
        assert_eq!(sanitizer.finish(), b"");
    }

    #[test]
    fn test_exec_output_sanitizer_normalizes_carriage_returns() {
        let sanitized = sanitize_exec_output_bytes(b"step 1\rstep 2\r\nstep 3");
        assert_eq!(
            String::from_utf8(sanitized).unwrap(),
            "step 1\nstep 2\nstep 3"
        );
    }
}
