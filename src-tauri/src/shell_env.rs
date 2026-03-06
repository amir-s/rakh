use std::path::Path;
use std::sync::OnceLock;

#[cfg(not(test))]
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoginShellEnv {
    pub path: Option<String>,
    pub shell: Option<String>,
    pub lang: Option<String>,
    pub lc_all: Option<String>,
    pub lc_ctype: Option<String>,
}

impl LoginShellEnv {
    pub fn has_any_value(&self) -> bool {
        self.path.is_some()
            || self.shell.is_some()
            || self.lang.is_some()
            || self.lc_all.is_some()
            || self.lc_ctype.is_some()
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

#[cfg(not(test))]
fn shell_name(shell_path: &str) -> &str {
    Path::new(shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
}

fn parse_login_shell_env_output(stdout: &str) -> LoginShellEnv {
    const PATH_PREFIX: &str = "__RAKH_PATH__";
    const SHELL_PREFIX: &str = "__RAKH_SHELL__";
    const LANG_PREFIX: &str = "__RAKH_LANG__";
    const LC_ALL_PREFIX: &str = "__RAKH_LC_ALL__";
    const LC_CTYPE_PREFIX: &str = "__RAKH_LC_CTYPE__";

    let mut env = LoginShellEnv::default();
    for line in stdout.lines() {
        if let Some(raw) = line.strip_prefix(PATH_PREFIX) {
            env.path = normalized_env_value(raw);
            continue;
        }
        if let Some(raw) = line.strip_prefix(SHELL_PREFIX) {
            env.shell = normalized_env_value(raw);
            continue;
        }
        if let Some(raw) = line.strip_prefix(LANG_PREFIX) {
            env.lang = normalized_env_value(raw);
            continue;
        }
        if let Some(raw) = line.strip_prefix(LC_ALL_PREFIX) {
            env.lc_all = normalized_env_value(raw);
            continue;
        }
        if let Some(raw) = line.strip_prefix(LC_CTYPE_PREFIX) {
            env.lc_ctype = normalized_env_value(raw);
        }
    }

    env
}

#[cfg(not(test))]
pub(crate) fn run_login_shell_script(shell_path: &str, script: &str) -> Option<String> {
    let mut cmd = Command::new(shell_path);
    match shell_name(shell_path) {
        "zsh" | "bash" | "fish" => {
            cmd.arg("-ilc");
        }
        _ => {
            cmd.arg("-lc");
        }
    }

    let output = cmd
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(not(test))]
fn run_login_shell_env_probe(shell_path: &str) -> Option<LoginShellEnv> {
    let script = if shell_name(shell_path) == "fish" {
        "printf '__RAKH_PATH__%s\\n' (string join : $PATH); \
         printf '__RAKH_SHELL__%s\\n' \"$SHELL\"; \
         printf '__RAKH_LANG__%s\\n' \"$LANG\"; \
         printf '__RAKH_LC_ALL__%s\\n' \"$LC_ALL\"; \
         printf '__RAKH_LC_CTYPE__%s\\n' \"$LC_CTYPE\""
    } else {
        "printf '__RAKH_PATH__%s\\n' \"${PATH-}\"; \
         printf '__RAKH_SHELL__%s\\n' \"${SHELL-}\"; \
         printf '__RAKH_LANG__%s\\n' \"${LANG-}\"; \
         printf '__RAKH_LC_ALL__%s\\n' \"${LC_ALL-}\"; \
         printf '__RAKH_LC_CTYPE__%s\\n' \"${LC_CTYPE-}\""
    };

    let stdout = run_login_shell_script(shell_path, script)?;
    let mut env = parse_login_shell_env_output(&stdout);
    if env.shell.is_none() {
        env.shell = Some(shell_path.to_string());
    }
    Some(env)
}

pub(crate) fn login_shell_candidates() -> Vec<String> {
    let mut shells = Vec::new();

    if let Some(shell) = std::env::var("SHELL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        shells.push(shell);
    }

    if cfg!(not(target_os = "windows")) {
        shells.push("/bin/zsh".to_string());
        shells.push("/bin/bash".to_string());
        shells.push("/bin/sh".to_string());
    }

    let mut unique = Vec::new();
    for shell in shells {
        if !Path::new(&shell).exists() {
            continue;
        }
        if unique.iter().any(|existing| existing == &shell) {
            continue;
        }
        unique.push(shell);
    }
    unique
}

#[cfg(not(test))]
fn read_login_shell_env() -> LoginShellEnv {
    for shell in login_shell_candidates() {
        if let Some(env) = run_login_shell_env_probe(&shell) {
            if env.has_any_value() {
                return env;
            }
        }
    }

    LoginShellEnv::default()
}

#[cfg(test)]
fn read_login_shell_env() -> LoginShellEnv {
    LoginShellEnv::default()
}

pub fn resolved_login_shell_env() -> LoginShellEnv {
    static CACHE: OnceLock<LoginShellEnv> = OnceLock::new();
    CACHE.get_or_init(read_login_shell_env).clone()
}

pub fn preferred_shell_path() -> String {
    let shell_env = resolved_login_shell_env();
    shell_env
        .shell
        .or_else(|| {
            std::env::var("SHELL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| login_shell_candidates().into_iter().next())
        .unwrap_or_else(|| "sh".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_login_shell_env_output_extracts_values() {
        let parsed = parse_login_shell_env_output(
            "__RAKH_PATH__/opt/homebrew/bin:/usr/bin\n\
             __RAKH_SHELL__/bin/zsh\n\
             __RAKH_LANG__en_CA.UTF-8\n\
             __RAKH_LC_ALL__\n\
             __RAKH_LC_CTYPE__UTF-8\n",
        );

        assert_eq!(parsed.path.as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parsed.shell.as_deref(), Some("/bin/zsh"));
        assert_eq!(parsed.lang.as_deref(), Some("en_CA.UTF-8"));
        assert_eq!(parsed.lc_all, None);
        assert_eq!(parsed.lc_ctype.as_deref(), Some("UTF-8"));
    }
}
