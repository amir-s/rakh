use crate::shell_env::resolved_login_shell_env;
use crate::utils::{home_dir, non_empty_env_var, tool_log};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    MacOs,
    Windows,
    Linux,
}

#[derive(Clone, Debug, Default)]
struct LaunchEnv {
    visual: Option<String>,
    editor: Option<String>,
    terminal: Option<String>,
    term_program: Option<String>,
    path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LaunchPlan {
    command: String,
    args: Vec<String>,
}

#[derive(Clone, Debug)]
struct EditorCandidate {
    cli: &'static str,
    mac_app: &'static str,
}

const EDITOR_CANDIDATES: &[EditorCandidate] = &[
    EditorCandidate {
        cli: "cursor",
        mac_app: "Cursor",
    },
    EditorCandidate {
        cli: "code",
        mac_app: "Visual Studio Code",
    },
    EditorCandidate {
        cli: "code-insiders",
        mac_app: "Visual Studio Code - Insiders",
    },
    EditorCandidate {
        cli: "windsurf",
        mac_app: "Windsurf",
    },
    EditorCandidate {
        cli: "codium",
        mac_app: "VSCodium",
    },
    EditorCandidate {
        cli: "zed",
        mac_app: "Zed",
    },
    EditorCandidate {
        cli: "subl",
        mac_app: "Sublime Text",
    },
];

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

fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

fn current_launch_env() -> LaunchEnv {
    let shell_env = resolved_login_shell_env();
    LaunchEnv {
        visual: non_empty_env_var("VISUAL"),
        editor: non_empty_env_var("EDITOR"),
        terminal: non_empty_env_var("TERMINAL"),
        term_program: non_empty_env_var("TERM_PROGRAM"),
        path: shell_env.path.or_else(|| non_empty_env_var("PATH")),
    }
}

fn parse_command_line(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;

    while let Some(ch) = chars.next() {
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                current.push(ch);
            }
            continue;
        }

        if in_double {
            match ch {
                '"' => in_double = false,
                '\\' => {
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                }
                _ => current.push(ch),
            }
            continue;
        }

        match ch {
            '\'' => in_single = true,
            '"' => in_double = true,
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

fn command_uses_explicit_path(command: &str) -> bool {
    command.contains(std::path::MAIN_SEPARATOR)
        || command.contains('/')
        || command.contains('\\')
        || Path::new(command).is_absolute()
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

fn split_command(input: &str) -> Option<(String, Vec<String>)> {
    let mut parts = parse_command_line(input).into_iter();
    let command = parts.next()?;
    Some((command, parts.collect()))
}

fn resolve_command(program: &str, path_env: Option<&str>) -> String {
    resolve_command_from_path(program, path_env)
        .unwrap_or_else(|| PathBuf::from(program))
        .to_string_lossy()
        .to_string()
}

fn mac_app_name_from_cli(program: &str) -> Option<&'static str> {
    let normalized = program.trim().to_ascii_lowercase();
    EDITOR_CANDIDATES
        .iter()
        .find(|candidate| candidate.cli == normalized)
        .map(|candidate| candidate.mac_app)
}

fn normalize_macos_app_name(program: &str) -> Option<String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(mapped) = mac_app_name_from_cli(trimmed) {
        return Some(mapped.to_string());
    }

    let path = Path::new(trimmed);
    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .or_else(|| path.file_name().and_then(|name| name.to_str()))
        .unwrap_or(trimmed)
        .trim_end_matches(".app")
        .trim();

    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn mac_open_command(path_env: Option<&str>) -> String {
    resolve_command("open", path_env)
}

fn macos_app_bundle_exists(app_name: &str) -> bool {
    let bundle = format!("{}.app", app_name.trim_end_matches(".app").trim());
    let mut candidates = vec![
        PathBuf::from("/Applications").join(&bundle),
        PathBuf::from("/System/Applications").join(&bundle),
    ];
    if let Some(home) = home_dir() {
        candidates.push(home.join("Applications").join(&bundle));
    }
    candidates.into_iter().any(|path| path.exists())
}

fn preferred_macos_editor_app() -> &'static str {
    EDITOR_CANDIDATES
        .iter()
        .map(|candidate| candidate.mac_app)
        .find(|app_name| macos_app_bundle_exists(app_name))
        .unwrap_or("Visual Studio Code")
}

fn mac_open_app_launch_plan(
    app_name: &str,
    target_path: &Path,
    extra_args: &[String],
    path_env: Option<&str>,
) -> LaunchPlan {
    let mut args = vec![
        "-a".to_string(),
        app_name.to_string(),
        target_path.to_string_lossy().to_string(),
    ];
    if !extra_args.is_empty() {
        args.push("--args".to_string());
        args.extend(extra_args.iter().cloned());
    }
    LaunchPlan {
        command: mac_open_command(path_env),
        args,
    }
}

fn build_editor_launch_plan(
    env: &LaunchEnv,
    target_path: &Path,
    platform: Platform,
) -> Result<LaunchPlan, String> {
    let target_arg = target_path.to_string_lossy().to_string();
    let path_env = env.path.as_deref();

    for preferred in [&env.visual, &env.editor] {
        let Some(raw) = preferred.as_deref() else {
            continue;
        };
        if let Some((program, mut args)) = split_command(raw) {
            let resolved = resolve_command_from_path(&program, path_env);
            if let Some(bin) = resolved {
                args.push(target_arg.clone());
                return Ok(LaunchPlan {
                    command: bin.to_string_lossy().to_string(),
                    args,
                });
            }

            if platform == Platform::MacOs {
                if let Some(app_name) = normalize_macos_app_name(&program) {
                    return Ok(mac_open_app_launch_plan(
                        &app_name,
                        target_path,
                        &args,
                        path_env,
                    ));
                }
            }

            args.push(target_arg.clone());
            return Ok(LaunchPlan {
                command: program,
                args,
            });
        }
    }

    for candidate in EDITOR_CANDIDATES {
        if let Some(bin) = resolve_command_from_path(candidate.cli, path_env) {
            return Ok(LaunchPlan {
                command: bin.to_string_lossy().to_string(),
                args: vec![target_arg.clone()],
            });
        }
    }

    if platform == Platform::MacOs {
        return Ok(mac_open_app_launch_plan(
            preferred_macos_editor_app(),
            target_path,
            &[],
            path_env,
        ));
    }

    Err(
        "Could not find an editor launcher. Set VISUAL or EDITOR, or install a supported editor CLI."
            .to_string(),
    )
}

fn terminal_app_from_term_program(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "apple_terminal" | "terminal" => Some("Terminal".to_string()),
        "iterm.app" | "iterm2" | "iterm" => Some("iTerm".to_string()),
        "ghostty" | "ghostty.app" => Some("Ghostty".to_string()),
        _ => normalize_macos_app_name(value),
    }
}

fn direct_terminal_launch_plan(raw: &str, path_env: Option<&str>) -> Option<LaunchPlan> {
    let (program, args) = split_command(raw)?;
    Some(LaunchPlan {
        command: resolve_command(&program, path_env),
        args,
    })
}

fn build_shell_launch_plan(
    env: &LaunchEnv,
    cwd: &Path,
    platform: Platform,
) -> Result<LaunchPlan, String> {
    let path_env = env.path.as_deref();

    if platform == Platform::MacOs {
        if let Some(raw) = env.terminal.as_deref() {
            if let Some((program, args)) = split_command(raw) {
                if let Some(bin) = resolve_command_from_path(&program, path_env) {
                    return Ok(LaunchPlan {
                        command: bin.to_string_lossy().to_string(),
                        args,
                    });
                }
                if let Some(app_name) = terminal_app_from_term_program(&program) {
                    return Ok(mac_open_app_launch_plan(&app_name, cwd, &args, path_env));
                }
            }
        }

        if let Some(raw) = env.term_program.as_deref() {
            if let Some(app_name) = terminal_app_from_term_program(raw) {
                return Ok(mac_open_app_launch_plan(&app_name, cwd, &[], path_env));
            }
        }

        return Ok(mac_open_app_launch_plan("Terminal", cwd, &[], path_env));
    }

    if let Some(raw) = env.terminal.as_deref() {
        if let Some(plan) = direct_terminal_launch_plan(raw, path_env) {
            return Ok(plan);
        }
    }

    if platform == Platform::Windows {
        for command in ["wt.exe", "wt"] {
            if let Some(bin) = resolve_command_from_path(command, path_env) {
                return Ok(LaunchPlan {
                    command: bin.to_string_lossy().to_string(),
                    args: vec!["-d".to_string(), cwd.to_string_lossy().to_string()],
                });
            }
        }

        for command in ["pwsh.exe", "pwsh", "powershell.exe", "cmd.exe", "cmd"] {
            if let Some(bin) = resolve_command_from_path(command, path_env) {
                let args = if command.starts_with("cmd") {
                    vec!["/K".to_string()]
                } else {
                    vec!["-NoExit".to_string()]
                };
                return Ok(LaunchPlan {
                    command: bin.to_string_lossy().to_string(),
                    args,
                });
            }
        }

        return Err("Could not find a terminal launcher on PATH.".to_string());
    }

    for command in [
        "x-terminal-emulator",
        "kgx",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "tilix",
        "kitty",
        "alacritty",
        "wezterm",
        "ghostty",
        "xterm",
    ] {
        if let Some(bin) = resolve_command_from_path(command, path_env) {
            let args = match command {
                "wezterm" => vec!["start".to_string()],
                _ => Vec::new(),
            };
            return Ok(LaunchPlan {
                command: bin.to_string_lossy().to_string(),
                args,
            });
        }
    }

    Err("Could not find a terminal launcher on PATH.".to_string())
}

fn ensure_valid_target(target: &str, allow_file: bool) -> Result<PathBuf, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("target must not be empty".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("target does not exist: {}", trimmed));
    }
    if path.is_dir() {
        return Ok(path);
    }
    if allow_file && path.is_file() {
        return Ok(path);
    }
    Err(format!("target is not a directory: {}", trimmed))
}

fn resolve_spawn_cwd(target: &Path) -> Result<PathBuf, String> {
    if target.is_dir() {
        return Ok(target.to_path_buf());
    }
    target.parent().map(Path::to_path_buf).ok_or_else(|| {
        format!(
            "Could not determine parent directory for {}",
            target.display()
        )
    })
}

fn spawn_plan(tool_name: &str, plan: &LaunchPlan, target: &Path) -> Result<(), String> {
    let spawn_cwd = resolve_spawn_cwd(target)?;
    if Path::new(&plan.command)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("open")
    {
        let status = Command::new(&plan.command)
            .args(&plan.args)
            .current_dir(&spawn_cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Failed to launch {}: {}", tool_name, error))?;
        if !status.success() {
            return Err(format!("Failed to launch {}", tool_name));
        }
        return Ok(());
    }

    Command::new(&plan.command)
        .args(&plan.args)
        .current_dir(&spawn_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch {}: {}", tool_name, error))
}

fn launch_external_tool(
    tool_name: &str,
    target: String,
    allow_file: bool,
    build_plan: fn(&LaunchEnv, &Path, Platform) -> Result<LaunchPlan, String>,
) -> Result<(), String> {
    let start = Instant::now();
    tool_log(tool_name, "start", json!({ "target": target }));

    let result: Result<(), String> = (|| {
        let validated_target = ensure_valid_target(&target, allow_file)?;
        let env = current_launch_env();
        let plan = build_plan(&env, &validated_target, current_platform())?;
        let plan_command = plan.command.clone();
        let plan_args = plan.args.clone();
        spawn_plan(tool_name, &plan, &validated_target)?;
        tool_log(
            tool_name,
            "ok",
            json!({
                "target": validated_target,
                "command": plan_command,
                "args": plan_args,
                "durationMs": start.elapsed().as_millis() as u64,
            }),
        );
        Ok(())
    })();

    if let Err(error) = &result {
        tool_log(
            tool_name,
            "err",
            json!({
                "target": target,
                "error": error,
                "durationMs": start.elapsed().as_millis() as u64,
            }),
        );
    }

    result
}

#[tauri::command]
pub fn open_in_editor(cwd: String) -> Result<(), String> {
    launch_external_tool("open_in_editor", cwd, true, build_editor_launch_plan)
}

#[tauri::command]
pub fn open_shell(cwd: String) -> Result<(), String> {
    launch_external_tool("open_shell", cwd, false, build_shell_launch_plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_parse_command_line_respects_quotes() {
        assert_eq!(
            parse_command_line("code --reuse-window \"My Project\""),
            vec![
                "code".to_string(),
                "--reuse-window".to_string(),
                "My Project".to_string(),
            ]
        );
    }

    #[test]
    fn test_build_editor_launch_plan_prefers_visual_env() {
        let temp = tempdir().expect("tempdir");
        let code = temp.path().join("code");
        std::fs::write(&code, "").expect("write fake editor");
        let cwd = temp.path().join("repo");
        std::fs::create_dir_all(&cwd).expect("create cwd");

        let env = LaunchEnv {
            visual: Some("code --reuse-window".to_string()),
            editor: Some("cursor".to_string()),
            terminal: None,
            term_program: None,
            path: Some(temp.path().to_string_lossy().to_string()),
        };

        let plan = build_editor_launch_plan(&env, &cwd, Platform::Linux).expect("plan");

        assert_eq!(plan.command, code.to_string_lossy());
        assert_eq!(
            plan.args,
            vec![
                "--reuse-window".to_string(),
                cwd.to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn test_build_editor_launch_plan_uses_macos_app_fallback() {
        let temp = tempdir().expect("tempdir");
        let open = temp.path().join("open");
        std::fs::write(&open, "").expect("write fake open");
        let cwd = temp.path().join("repo");
        std::fs::create_dir_all(&cwd).expect("create cwd");

        let env = LaunchEnv {
            visual: None,
            editor: Some("Cursor".to_string()),
            terminal: None,
            term_program: None,
            path: Some(temp.path().to_string_lossy().to_string()),
        };

        let plan = build_editor_launch_plan(&env, &cwd, Platform::MacOs).expect("plan");

        assert_eq!(plan.command, open.to_string_lossy());
        assert_eq!(
            plan.args,
            vec![
                "-a".to_string(),
                "Cursor".to_string(),
                cwd.to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn test_build_shell_launch_plan_prefers_windows_terminal() {
        let temp = tempdir().expect("tempdir");
        let wt = temp.path().join("wt.exe");
        std::fs::write(&wt, "").expect("write fake wt");
        let cwd = temp.path().join("repo");
        std::fs::create_dir_all(&cwd).expect("create cwd");

        let env = LaunchEnv {
            visual: None,
            editor: None,
            terminal: None,
            term_program: None,
            path: Some(temp.path().to_string_lossy().to_string()),
        };

        let plan = build_shell_launch_plan(&env, &cwd, Platform::Windows).expect("plan");

        assert_eq!(plan.command, wt.to_string_lossy());
        assert_eq!(
            plan.args,
            vec!["-d".to_string(), cwd.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn test_build_shell_launch_plan_uses_macos_terminal_app_from_term_program() {
        let temp = tempdir().expect("tempdir");
        let open = temp.path().join("open");
        std::fs::write(&open, "").expect("write fake open");
        let cwd = temp.path().join("repo");
        std::fs::create_dir_all(&cwd).expect("create cwd");

        let env = LaunchEnv {
            visual: None,
            editor: None,
            terminal: None,
            term_program: Some("iTerm.app".to_string()),
            path: Some(temp.path().to_string_lossy().to_string()),
        };

        let plan = build_shell_launch_plan(&env, &cwd, Platform::MacOs).expect("plan");

        assert_eq!(plan.command, open.to_string_lossy());
        assert_eq!(
            plan.args,
            vec![
                "-a".to_string(),
                "iTerm".to_string(),
                cwd.to_string_lossy().to_string(),
            ]
        );
    }
}
