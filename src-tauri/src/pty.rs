use crate::db::AppState;
use crate::shell_env::{preferred_shell_path, resolved_login_shell_env};
use crate::utils::{tool_log, tool_logging_enabled};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde_json::json;
use std::io::Read;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

static WRITE_PTY_CALLS: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn spawn_pty(
    cwd: String,
    rows: u16,
    cols: u16,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let start = Instant::now();
    tool_log(
        "spawn_pty",
        "start",
        json!({ "cwd": cwd, "rows": rows, "cols": cols }),
    );

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            tool_log(
                "spawn_pty",
                "err",
                json!({
                    "durationMs": start.elapsed().as_millis() as u64,
                    "error": e.to_string()
                }),
            );
            e.to_string()
        })?;

    let shell_env = resolved_login_shell_env();
    let shell = preferred_shell_path();
    let mut cmd = CommandBuilder::new(shell.clone());
    cmd.cwd(cwd);
    cmd.env("SHELL", shell.clone());
    if let Some(path) = shell_env.path.as_deref() {
        cmd.env("PATH", path);
    }
    if std::env::var("TERM")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .is_none()
    {
        cmd.env("TERM", "xterm-256color");
    }
    if std::env::var("COLORTERM")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .is_none()
    {
        cmd.env("COLORTERM", "truecolor");
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

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session_id = Uuid::new_v4().to_string();
    let session_id_clone = session_id.clone();
    let exit_session_id = session_id.clone();
    let exit_app_handle = app_handle.clone();

    state
        .pty_writers
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(Mutex::new(writer)));
    state
        .pty_masters
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(Mutex::new(pair.master)));

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = buf[..n].to_vec();
                    let _ = app_handle.emit(&format!("pty-output-{}", session_id_clone), data);
                }
                _ => break,
            }
        }
    });

    std::thread::spawn(move || {
        let payload = match child.wait() {
            Ok(status) => json!({
                "exitCode": status.exit_code(),
                "signal": status.signal(),
            }),
            Err(err) => json!({
                "exitCode": -1,
                "error": err.to_string(),
            }),
        };

        tool_log(
            "pty_exit",
            "event",
            json!({
                "sessionId": exit_session_id,
                "exitCode": payload["exitCode"],
                "signal": payload.get("signal").cloned().unwrap_or(json!(null)),
                "error": payload.get("error").cloned().unwrap_or(json!(null))
            }),
        );

        let app_state = exit_app_handle.state::<AppState>();
        app_state
            .pty_writers
            .lock()
            .unwrap()
            .remove(&exit_session_id);
        app_state
            .pty_masters
            .lock()
            .unwrap()
            .remove(&exit_session_id);
        let _ = exit_app_handle.emit(&format!("pty-exit-{}", exit_session_id), payload);
    });

    tool_log(
        "spawn_pty",
        "ok",
        json!({
            "durationMs": start.elapsed().as_millis() as u64,
            "sessionId": session_id
        }),
    );

    Ok(session_id)
}

#[tauri::command]
pub fn write_pty(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Avoid spamming logs for every PTY write; log every 200th call and all errors.
    let n = WRITE_PTY_CALLS.fetch_add(1, Ordering::Relaxed) + 1;
    let should_log = tool_logging_enabled() && (n % 200 == 0);
    if should_log {
        tool_log(
            "write_pty",
            "start",
            json!({ "sessionId": session_id, "bytes": data.as_bytes().len(), "seq": n }),
        );
    }

    let result: Result<(), String> = (|| {
        if let Some(writer) = state.pty_writers.lock().unwrap().get(&session_id) {
            let mut writer = writer.lock().unwrap();
            writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    })();

    if should_log {
        match &result {
            Ok(()) => tool_log("write_pty", "ok", json!({ "seq": n })),
            Err(e) => tool_log("write_pty", "err", json!({ "seq": n, "error": e })),
        }
    } else if let Err(e) = &result {
        tool_log(
            "write_pty",
            "err",
            json!({ "sessionId": session_id, "bytes": data.as_bytes().len(), "seq": n, "error": e }),
        );
    }

    result
}

#[tauri::command]
pub fn resize_pty(
    session_id: String,
    rows: u16,
    cols: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let start = Instant::now();
    tool_log(
        "resize_pty",
        "start",
        json!({ "sessionId": session_id, "rows": rows, "cols": cols }),
    );

    let result: Result<(), String> = (|| {
        if let Some(master) = state.pty_masters.lock().unwrap().get(&session_id) {
            let master = master.lock().unwrap();
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    })();

    match &result {
        Ok(()) => tool_log(
            "resize_pty",
            "ok",
            json!({ "durationMs": start.elapsed().as_millis() as u64 }),
        ),
        Err(e) => tool_log(
            "resize_pty",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}
