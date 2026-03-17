use crate::shell_env::{preferred_shell_path, resolved_login_shell_env};
use crate::utils::{app_store_root, home_dir, now_ms, tool_log};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub const CLI_OPEN_REQUEST_EVENT: &str = "rakh_cli_open_request";
const CLI_OPEN_FLAG: &str = "--rakh-cli-open";
const CLI_ADD_PROJECT_FLAG: &str = "--rakh-cli-add-project";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliOpenRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub add_project: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_path: Option<String>,
    pub bin_dir: String,
    pub app_executable_path: String,
    pub on_path: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_path_snippet: Option<String>,
    pub needs_terminal_restart: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
enum CliPathMode {
    #[default]
    Manual,
    ShellConfig,
    WindowsRegistry,
    Existing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CliInstallMetadata {
    pub command_path: String,
    pub bin_dir: String,
    #[serde(default)]
    pub path_mode: CliPathMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_target: Option<String>,
}

#[derive(Default)]
pub struct CliState {
    pending_requests: Mutex<VecDeque<CliOpenRequest>>,
    frontend_ready: Mutex<bool>,
}

impl CliState {
    pub fn enqueue(&self, request: CliOpenRequest) {
        if let Ok(mut pending) = self.pending_requests.lock() {
            pending.push_back(request);
        }
    }

    pub fn drain_pending(&self) -> Vec<CliOpenRequest> {
        let mut pending = self.pending_requests.lock().unwrap();
        pending.drain(..).collect()
    }

    pub fn mark_frontend_ready(&self) {
        if let Ok(mut ready) = self.frontend_ready.lock() {
            *ready = true;
        }
    }

    pub fn is_frontend_ready(&self) -> bool {
        self.frontend_ready
            .lock()
            .map(|ready| *ready)
            .unwrap_or(false)
    }
}

fn cli_config_path() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("config").join("cli.json"))
}

fn managed_bin_dir() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("bin"))
}

fn managed_command_path() -> Result<PathBuf, String> {
    Ok(managed_bin_dir()?.join(cli_command_name()))
}

fn cli_command_name() -> &'static str {
    if cfg!(windows) {
        "rakh.cmd"
    } else {
        "rakh"
    }
}

fn current_app_executable_path() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("INTERNAL: cannot determine app executable path: {error}"))
}

fn path_env_contains_dir(path_env: Option<&str>, dir: &Path) -> bool {
    let Ok(target) = dir.canonicalize() else {
        return false;
    };

    path_env
        .map(|raw| {
            env::split_paths(raw).any(|entry| {
                entry
                    .canonicalize()
                    .map(|candidate| candidate == target)
                    .unwrap_or(false)
                    || entry == dir
            })
        })
        .unwrap_or(false)
}

fn current_process_path_contains(dir: &Path) -> bool {
    path_env_contains_dir(std::env::var("PATH").ok().as_deref(), dir)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellConfigKind {
    Zsh,
    Bash,
    Fish,
    Posix,
}

const CLI_PATH_BLOCK_START: &str = "# >>> rakh cli >>>";
const CLI_PATH_BLOCK_END: &str = "# <<< rakh cli <<<";

#[cfg(windows)]
fn target_path_env() -> Option<String> {
    read_windows_user_path().or_else(|| std::env::var("PATH").ok())
}

#[cfg(not(windows))]
fn target_path_env() -> Option<String> {
    resolved_login_shell_env()
        .path
        .or_else(|| std::env::var("PATH").ok())
}

fn manual_path_snippet(bin_dir: &Path, on_path: bool) -> Option<String> {
    if cfg!(windows) || on_path {
        return None;
    }

    Some(format!(
        "export PATH=\"{}:$PATH\"",
        home_relative_bin_dir(bin_dir)
    ))
}

fn home_relative_bin_dir(bin_dir: &Path) -> String {
    let rendered = if let Some(home) = home_dir() {
        if let Ok(relative) = bin_dir.strip_prefix(&home) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty() {
                "$HOME".to_string()
            } else {
                format!("$HOME/{relative}")
            }
        } else {
            bin_dir.to_string_lossy().to_string()
        }
    } else {
        bin_dir.to_string_lossy().to_string()
    };

    rendered
}

fn shell_escape_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn batch_escape_value(value: &str) -> String {
    value.replace('%', "%%")
}

fn render_unix_launcher(app_path: &Path) -> String {
    let escaped_app = shell_escape_single_quoted(&app_path.to_string_lossy());

    format!(
        r#"#!/bin/sh
APP={escaped_app}
ADD_PROJECT=0
TARGET=""

print_usage() {{
  echo "Usage: rakh [path]"
  echo "       rakh -a <path>"
}}

if [ ! -x "$APP" ]; then
  echo "rakh: Rakh app executable not found: $APP" >&2
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    -a)
      ADD_PROJECT=1
      ;;
    -*)
      echo "rakh: unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "rakh: expected at most one path argument" >&2
        exit 2
      fi
      TARGET=$1
      ;;
  esac
  shift
done

if [ "$ADD_PROJECT" -eq 1 ] && [ -z "$TARGET" ]; then
  echo "rakh: -a requires a path" >&2
  exit 2
fi

if [ -n "$TARGET" ]; then
  if [ ! -e "$TARGET" ]; then
    echo "rakh: path not found: $TARGET" >&2
    exit 1
  fi

  if [ -d "$TARGET" ]; then
    if ! TARGET_DIR=$(cd "$TARGET" 2>/dev/null && pwd -P); then
      echo "rakh: could not open directory: $TARGET" >&2
      exit 1
    fi
  else
    TARGET_PARENT=$(dirname "$TARGET")
    if [ ! -d "$TARGET_PARENT" ]; then
      echo "rakh: could not resolve parent directory for: $TARGET" >&2
      exit 1
    fi
    if ! TARGET_DIR=$(cd "$TARGET_PARENT" 2>/dev/null && pwd -P); then
      echo "rakh: could not open parent directory for: $TARGET" >&2
      exit 1
    fi
  fi

  set -- "{CLI_OPEN_FLAG}" "$TARGET_DIR"
  if [ "$ADD_PROJECT" -eq 1 ]; then
    set -- "$@" "{CLI_ADD_PROJECT_FLAG}"
  fi
else
  set --
fi

nohup "$APP" "$@" >/dev/null 2>&1 &
"#
    )
}

fn render_windows_launcher(app_path: &Path) -> String {
    let escaped_app = batch_escape_value(&app_path.to_string_lossy());

    format!(
        r#"@echo off
setlocal EnableExtensions
set "APP={escaped_app}"
set "ADD_PROJECT=0"
set "TARGET="

if not exist "%APP%" (
  echo rakh: Rakh app executable not found: %APP% 1>&2
  exit /b 1
)

:parse
if "%~1"=="" goto parsed
if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage
if /I "%~1"=="-a" (
  set "ADD_PROJECT=1"
  shift
  goto parse
)
if defined TARGET goto error_extra
set "TARGET=%~1"
shift
goto parse

:parsed
if "%ADD_PROJECT%"=="1" if not defined TARGET goto error_add_requires_path
set "TARGET_DIR="
if defined TARGET (
  if not exist "%TARGET%" goto error_missing
  for %%I in ("%TARGET%") do (
    if exist "%%~fI\" (
      set "TARGET_DIR=%%~fI"
    ) else (
      set "TARGET_DIR=%%~dpI"
    )
  )
)

if defined TARGET_DIR (
  if "%ADD_PROJECT%"=="1" (
    start "" "%APP%" {CLI_OPEN_FLAG} "%TARGET_DIR%" {CLI_ADD_PROJECT_FLAG}
  ) else (
    start "" "%APP%" {CLI_OPEN_FLAG} "%TARGET_DIR%"
  )
) else (
  start "" "%APP%"
)
exit /b 0

:usage
echo Usage: rakh [path]
echo        rakh -a ^<path^>
exit /b 0

:error_missing
echo rakh: path not found: %TARGET% 1>&2
exit /b 1

:error_extra
echo rakh: expected at most one path argument 1>&2
exit /b 2

:error_add_requires_path
echo rakh: -a requires a path 1>&2
exit /b 2
"#
    )
}

fn render_launcher(app_path: &Path) -> String {
    if cfg!(windows) {
        render_windows_launcher(app_path)
    } else {
        render_unix_launcher(app_path)
    }
}

fn detect_shell_config_kind() -> ShellConfigKind {
    let shell_path = preferred_shell_path();
    let shell_name = Path::new(&shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    match shell_name {
        "zsh" => ShellConfigKind::Zsh,
        "bash" => ShellConfigKind::Bash,
        "fish" => ShellConfigKind::Fish,
        _ => ShellConfigKind::Posix,
    }
}

fn shell_config_path(kind: ShellConfigKind) -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let path = match kind {
        ShellConfigKind::Zsh => home.join(".zshrc"),
        ShellConfigKind::Bash => {
            if cfg!(target_os = "macos") {
                home.join(".bash_profile")
            } else {
                home.join(".bashrc")
            }
        }
        ShellConfigKind::Fish => home.join(".config").join("fish").join("config.fish"),
        ShellConfigKind::Posix => home.join(".profile"),
    };
    Ok(path)
}

fn render_shell_path_block(bin_dir: &Path, kind: ShellConfigKind) -> String {
    let rendered_dir = home_relative_bin_dir(bin_dir);
    match kind {
        ShellConfigKind::Fish => format!(
            "{CLI_PATH_BLOCK_START}\nif not contains \"{rendered_dir}\" $PATH\n    set -gx PATH \"{rendered_dir}\" $PATH\nend\n{CLI_PATH_BLOCK_END}\n"
        ),
        ShellConfigKind::Zsh | ShellConfigKind::Bash | ShellConfigKind::Posix => format!(
            "{CLI_PATH_BLOCK_START}\ncase \":$PATH:\" in\n  *\":{rendered_dir}:\"*) ;;\n  *) export PATH=\"{rendered_dir}:$PATH\" ;;\nesac\n{CLI_PATH_BLOCK_END}\n"
        ),
    }
}

fn replace_or_append_managed_block(existing: &str, block: &str) -> String {
    match (
        existing.find(CLI_PATH_BLOCK_START),
        existing.find(CLI_PATH_BLOCK_END),
    ) {
        (Some(start), Some(end)) if end >= start => {
            let end = end + CLI_PATH_BLOCK_END.len();
            let mut next = String::new();
            next.push_str(&existing[..start]);
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(block);
            let suffix = existing[end..].trim_start_matches('\n');
            if !suffix.is_empty() {
                if !next.ends_with('\n') {
                    next.push('\n');
                }
                next.push_str(suffix);
                if !next.ends_with('\n') {
                    next.push('\n');
                }
            }
            next
        }
        _ => {
            let mut next = existing.to_string();
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            if !next.is_empty() {
                next.push('\n');
            }
            next.push_str(block);
            next
        }
    }
}

fn remove_managed_block(existing: &str) -> String {
    match (
        existing.find(CLI_PATH_BLOCK_START),
        existing.find(CLI_PATH_BLOCK_END),
    ) {
        (Some(start), Some(end)) if end >= start => {
            let end = end + CLI_PATH_BLOCK_END.len();
            let mut next = String::new();
            next.push_str(existing[..start].trim_end_matches('\n'));
            let suffix = existing[end..].trim_start_matches('\n');
            if !next.is_empty() && !suffix.is_empty() {
                next.push_str("\n\n");
            } else if !next.is_empty() || !suffix.is_empty() {
                next.push('\n');
            }
            next.push_str(suffix);
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next
        }
        _ => existing.to_string(),
    }
}

fn update_unix_shell_path(
    bin_dir: &Path,
    install: bool,
    current_target: Option<&str>,
) -> Result<(CliPathMode, Option<String>), String> {
    if install
        && current_target.is_none()
        && path_env_contains_dir(target_path_env().as_deref(), bin_dir)
    {
        return Ok((CliPathMode::Existing, None));
    }

    let kind = detect_shell_config_kind();
    let config_path = current_target
        .map(PathBuf::from)
        .unwrap_or(shell_config_path(kind)?);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create shell config dir: {error}"))?;
    }

    let existing = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|error| format!("INTERNAL: cannot read shell config: {error}"))?
    } else {
        String::new()
    };

    let next = if install {
        replace_or_append_managed_block(&existing, &render_shell_path_block(bin_dir, kind))
    } else {
        remove_managed_block(&existing)
    };

    fs::write(&config_path, next.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write shell config: {error}"))?;

    Ok(if install {
        (
            CliPathMode::ShellConfig,
            Some(config_path.to_string_lossy().to_string()),
        )
    } else {
        (
            CliPathMode::Manual,
            Some(config_path.to_string_lossy().to_string()),
        )
    })
}

fn load_metadata() -> Result<Option<CliInstallMetadata>, String> {
    let path = cli_config_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("INTERNAL: cannot read cli config: {error}"))?;
    let metadata = serde_json::from_str(&raw)
        .map_err(|error| format!("INTERNAL: cannot parse cli config: {error}"))?;
    Ok(Some(metadata))
}

fn save_metadata(metadata: &CliInstallMetadata) -> Result<(), String> {
    let path = cli_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create cli config dir: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("INTERNAL: cannot serialise cli config: {error}"))?;
    let tmp = path.with_extension(format!("json.tmp-{}", now_ms()));
    fs::write(&tmp, raw.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write cli config tmp: {error}"))?;
    match fs::rename(&tmp, &path) {
        Ok(()) => {}
        Err(error) => {
            if path.exists() {
                let _ = fs::remove_file(&tmp);
            } else {
                return Err(format!("INTERNAL: cannot rename cli config file: {error}"));
            }
        }
    }

    Ok(())
}

fn remove_metadata() -> Result<(), String> {
    let path = cli_config_path()?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|error| format!("INTERNAL: cannot remove cli config: {error}"))
}

fn write_launcher_to(command_path: &Path, app_path: &Path) -> Result<(), String> {
    if let Some(parent) = command_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create cli bin dir: {error}"))?;
    }

    let content = render_launcher(app_path);
    fs::write(command_path, content.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write cli launcher: {error}"))?;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(command_path)
            .map_err(|error| format!("INTERNAL: cannot stat cli launcher: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(command_path, permissions)
            .map_err(|error| format!("INTERNAL: cannot chmod cli launcher: {error}"))?;
    }

    Ok(())
}

#[cfg(windows)]
fn read_windows_user_path() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu.open_subkey("Environment").ok()?;
    env.get_value::<String, _>("Path").ok()
}

#[cfg(windows)]
fn update_windows_user_path(bin_dir: &Path, install: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env_key, _) = hkcu
        .create_subkey("Environment")
        .map_err(|error| format!("INTERNAL: cannot open user PATH registry key: {error}"))?;

    let existing = env_key.get_value::<String, _>("Path").unwrap_or_default();
    let mut entries: Vec<PathBuf> = env::split_paths(&existing).collect();

    let target = bin_dir.to_path_buf();
    let contains = entries.iter().any(|entry| entry == &target);
    if install {
        if !contains {
            entries.push(target);
        }
    } else if contains {
        entries.retain(|entry| entry != &target);
    }

    let joined = env::join_paths(entries.iter())
        .map_err(|error| format!("INTERNAL: cannot serialise user PATH: {error}"))?;
    env_key
        .set_value("Path", &joined.to_string_lossy().to_string())
        .map_err(|error| format!("INTERNAL: cannot update user PATH: {error}"))?;

    Ok(())
}

#[cfg(not(windows))]
fn update_windows_user_path(_bin_dir: &Path, _install: bool) -> Result<(), String> {
    Ok(())
}

fn build_status_from_metadata(metadata: Option<&CliInstallMetadata>) -> Result<CliStatus, String> {
    let app_executable_path = current_app_executable_path()?;
    let bin_dir = managed_bin_dir()?;
    let bin_dir_string = bin_dir.to_string_lossy().to_string();
    let target_path = target_path_env();
    let actual_on_path = path_env_contains_dir(target_path.as_deref(), &bin_dir);
    let installed = metadata
        .and_then(|value| {
            let path = PathBuf::from(&value.command_path);
            path.exists().then_some(path)
        })
        .is_some();
    let path_configured = metadata
        .map(|value| {
            matches!(
                value.path_mode,
                CliPathMode::ShellConfig | CliPathMode::WindowsRegistry | CliPathMode::Existing
            )
        })
        .unwrap_or(false);
    let on_path = actual_on_path || path_configured;
    let manual_path_snippet = if installed
        && metadata
            .map(|value| value.path_mode == CliPathMode::Manual)
            .unwrap_or(false)
    {
        manual_path_snippet(&bin_dir, false)
    } else {
        None
    };

    Ok(CliStatus {
        installed,
        command_path: metadata.map(|value| value.command_path.clone()),
        bin_dir: bin_dir_string,
        app_executable_path: app_executable_path.to_string_lossy().to_string(),
        on_path,
        manual_path_snippet,
        needs_terminal_restart: installed && on_path && !current_process_path_contains(&bin_dir),
    })
}

fn install_launcher() -> Result<CliStatus, String> {
    let command_path = managed_command_path()?;
    let app_path = current_app_executable_path()?;
    let bin_dir = managed_bin_dir()?;
    write_launcher_to(&command_path, &app_path)?;
    let mut metadata = CliInstallMetadata {
        command_path: command_path.to_string_lossy().to_string(),
        bin_dir: bin_dir.to_string_lossy().to_string(),
        path_mode: CliPathMode::Manual,
        path_target: None,
    };
    #[cfg(windows)]
    {
        match update_windows_user_path(&bin_dir, true) {
            Ok(()) => {
                metadata.path_mode = CliPathMode::WindowsRegistry;
            }
            Err(error) => {
                tool_log("cli_install", "warn", json!({ "pathUpdateError": error }));
            }
        }
    }
    #[cfg(not(windows))]
    {
        match update_unix_shell_path(&bin_dir, true, None) {
            Ok((path_mode, path_target)) => {
                metadata.path_mode = path_mode;
                metadata.path_target = path_target;
            }
            Err(error) => {
                tool_log("cli_install", "warn", json!({ "pathUpdateError": error }));
            }
        }
    }
    save_metadata(&metadata)?;
    build_status_from_metadata(Some(&metadata))
}

fn uninstall_launcher() -> Result<CliStatus, String> {
    if let Some(metadata) = load_metadata()? {
        let command_path = PathBuf::from(&metadata.command_path);
        if command_path.exists() {
            let _ = fs::remove_file(&command_path);
        }
        match metadata.path_mode {
            CliPathMode::WindowsRegistry => {
                update_windows_user_path(Path::new(&metadata.bin_dir), false)?;
            }
            CliPathMode::ShellConfig => {
                let bin_dir = PathBuf::from(&metadata.bin_dir);
                let _ = update_unix_shell_path(&bin_dir, false, metadata.path_target.as_deref());
            }
            CliPathMode::Manual | CliPathMode::Existing => {}
        }
        if let Ok(bin_dir) = managed_bin_dir() {
            if bin_dir.exists() {
                let _ = fs::remove_dir(&bin_dir);
            }
        }
    }
    remove_metadata()?;
    build_status_from_metadata(None)
}

pub fn refresh_installed_launcher_if_needed() -> Result<(), String> {
    let Some(mut metadata) = load_metadata()? else {
        return Ok(());
    };
    let command_path = PathBuf::from(&metadata.command_path);
    let app_path = current_app_executable_path()?;
    write_launcher_to(&command_path, &app_path)?;
    #[cfg(windows)]
    {
        if update_windows_user_path(Path::new(&metadata.bin_dir), true).is_ok() {
            metadata.path_mode = CliPathMode::WindowsRegistry;
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok((path_mode, path_target)) = update_unix_shell_path(
            Path::new(&metadata.bin_dir),
            true,
            metadata.path_target.as_deref(),
        ) {
            metadata.path_mode = path_mode;
            metadata.path_target = path_target;
        }
    }
    save_metadata(&metadata)?;
    Ok(())
}

fn parse_cli_request<I, S>(args: I) -> Option<CliOpenRequest>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut path: Option<String> = None;
    let mut add_project = false;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let value = arg.as_ref();
        if value == CLI_OPEN_FLAG {
            let next = iter.next()?.as_ref().trim().to_string();
            if next.is_empty() {
                return None;
            }
            path = Some(next);
            continue;
        }
        if value == CLI_ADD_PROJECT_FLAG {
            add_project = true;
        }
    }

    if path.is_none() {
        return None;
    }

    Some(CliOpenRequest { path, add_project })
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn capture_startup_cli_request(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    if let Some(request) = parse_cli_request(&args) {
        let state = app.state::<CliState>();
        state.enqueue(request);
    }
}

pub fn handle_secondary_cli_invocation(app: &AppHandle, args: Vec<String>) {
    focus_main_window(app);
    let Some(request) = parse_cli_request(&args) else {
        return;
    };

    let state = app.state::<CliState>();
    if state.is_frontend_ready() {
        let _ = app.emit(CLI_OPEN_REQUEST_EVENT, request);
    } else {
        state.enqueue(request);
    }
}

#[tauri::command]
pub fn cli_get_status() -> Result<CliStatus, String> {
    tool_log("cli_get_status", "start", json!({}));
    let metadata = load_metadata()?;
    let status = build_status_from_metadata(metadata.as_ref())?;
    tool_log(
        "cli_get_status",
        "ok",
        json!({
            "installed": status.installed,
            "onPath": status.on_path,
            "needsTerminalRestart": status.needs_terminal_restart,
        }),
    );
    Ok(status)
}

#[tauri::command]
pub fn cli_install() -> Result<CliStatus, String> {
    tool_log("cli_install", "start", json!({}));
    let status = install_launcher()?;
    tool_log(
        "cli_install",
        "ok",
        json!({
            "installed": status.installed,
            "commandPath": status.command_path,
            "onPath": status.on_path,
        }),
    );
    Ok(status)
}

#[tauri::command]
pub fn cli_uninstall() -> Result<CliStatus, String> {
    tool_log("cli_uninstall", "start", json!({}));
    let status = uninstall_launcher()?;
    tool_log(
        "cli_uninstall",
        "ok",
        json!({
            "installed": status.installed,
            "onPath": status.on_path,
        }),
    );
    Ok(status)
}

#[tauri::command]
pub fn cli_take_pending_requests(
    state: State<'_, CliState>,
) -> Result<Vec<CliOpenRequest>, String> {
    state.mark_frontend_ready();
    Ok(state.drain_pending())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn with_temp_home<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::db::HOME_TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap();
        let tmp = tempdir().unwrap();
        let prev_home = std::env::var("HOME").ok();
        let prev_userprofile = std::env::var("USERPROFILE").ok();
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("USERPROFILE", tmp.path());

        let result = f();

        match prev_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match prev_userprofile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }

        result
    }

    #[test]
    fn parses_hidden_cli_flags() {
        let request = parse_cli_request([
            "Rakh",
            "--other",
            CLI_OPEN_FLAG,
            "/tmp/project",
            CLI_ADD_PROJECT_FLAG,
        ])
        .expect("expected cli request");

        assert_eq!(
            request,
            CliOpenRequest {
                path: Some("/tmp/project".to_string()),
                add_project: true,
            }
        );
    }

    #[test]
    fn ignores_missing_open_flag() {
        let request = parse_cli_request(["Rakh", "--help", CLI_ADD_PROJECT_FLAG]);
        assert_eq!(request, None);
    }

    #[test]
    fn unix_launcher_contains_hidden_flags() {
        let launcher =
            render_unix_launcher(Path::new("/Applications/Rakh.app/Contents/MacOS/Rakh"));
        assert!(launcher.contains(CLI_OPEN_FLAG));
        assert!(launcher.contains(CLI_ADD_PROJECT_FLAG));
        assert!(launcher.contains("nohup \"$APP\" \"$@\" >/dev/null 2>&1 &"));
    }

    #[test]
    fn windows_launcher_contains_hidden_flags() {
        let launcher = render_windows_launcher(Path::new(r"C:\Program Files\Rakh\Rakh.exe"));
        assert!(launcher.contains(CLI_OPEN_FLAG));
        assert!(launcher.contains(CLI_ADD_PROJECT_FLAG));
        assert!(launcher.contains("start \"\" \"%APP%\""));
    }

    #[test]
    fn shell_snippet_uses_home_variable_when_possible() {
        let path = Path::new("/Users/tester/.rakh/bin");
        let prev_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", "/Users/tester");
        let snippet = manual_path_snippet(path, false).expect("snippet");
        match prev_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(snippet, "export PATH=\"$HOME/.rakh/bin:$PATH\"");
    }

    #[test]
    fn unix_shell_path_update_writes_and_removes_managed_block() {
        with_temp_home(|| {
            let prev_shell = std::env::var("SHELL").ok();
            std::env::set_var("SHELL", "/bin/zsh");

            let bin_dir = managed_bin_dir().unwrap();
            let (mode, target) =
                update_unix_shell_path(&bin_dir, true, None).expect("install path");
            assert_eq!(mode, CliPathMode::ShellConfig);

            let config_path = PathBuf::from(target.expect("target path"));
            let raw = fs::read_to_string(&config_path).expect("shell config should exist");
            assert!(raw.contains(CLI_PATH_BLOCK_START));
            assert!(raw.contains("$HOME/.rakh-dev/bin"));

            let _ = update_unix_shell_path(
                &bin_dir,
                false,
                Some(config_path.to_string_lossy().as_ref()),
            )
            .expect("uninstall path");
            let cleaned =
                fs::read_to_string(&config_path).expect("shell config should still exist");
            assert!(!cleaned.contains(CLI_PATH_BLOCK_START));

            match prev_shell {
                Some(value) => std::env::set_var("SHELL", value),
                None => std::env::remove_var("SHELL"),
            }
        });
    }

    #[test]
    fn metadata_round_trip_and_status() {
        with_temp_home(|| {
            let metadata = CliInstallMetadata {
                command_path: managed_command_path()
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
                bin_dir: managed_bin_dir().unwrap().to_string_lossy().to_string(),
                path_mode: CliPathMode::Manual,
                path_target: None,
            };

            save_metadata(&metadata).expect("save should succeed");
            let loaded = load_metadata().expect("load should succeed");
            assert_eq!(loaded, Some(metadata.clone()));

            write_launcher_to(Path::new(&metadata.command_path), Path::new("/tmp/Rakh"))
                .expect("launcher write should succeed");
            let status = build_status_from_metadata(Some(&metadata)).expect("status");
            assert!(status.installed);
            assert_eq!(
                status.command_path.as_deref(),
                Some(metadata.command_path.as_str())
            );
        });
    }

    #[test]
    fn refresh_rewrites_existing_launcher() {
        with_temp_home(|| {
            let command_path = managed_command_path().unwrap();
            let metadata = CliInstallMetadata {
                command_path: command_path.to_string_lossy().to_string(),
                bin_dir: managed_bin_dir().unwrap().to_string_lossy().to_string(),
                path_mode: CliPathMode::Manual,
                path_target: None,
            };
            save_metadata(&metadata).expect("save should succeed");
            write_launcher_to(&command_path, Path::new("/tmp/old-rakh")).expect("launcher write");

            refresh_installed_launcher_if_needed().expect("refresh should succeed");

            let raw = fs::read_to_string(&command_path).expect("launcher should exist");
            let current_exe = current_app_executable_path().unwrap();
            assert!(raw.contains(current_exe.to_string_lossy().as_ref()));
        });
    }

    #[test]
    fn cli_state_drains_pending_requests() {
        let state = CliState::default();
        state.enqueue(CliOpenRequest {
            path: Some("/repo".to_string()),
            add_project: false,
        });
        state.enqueue(CliOpenRequest {
            path: Some("/repo-2".to_string()),
            add_project: true,
        });

        state.mark_frontend_ready();
        assert!(state.is_frontend_ready());

        let drained = state.drain_pending();
        assert_eq!(drained.len(), 2);
        assert!(state.drain_pending().is_empty());
    }
}
