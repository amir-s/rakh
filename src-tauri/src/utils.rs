use crate::logging::{
    tool_log as structured_tool_log, tool_log_with_context as structured_tool_log_with_context,
    tool_logging_enabled as structured_tool_logging_enabled, LogContext,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(|| {
            // Windows fallback when USERPROFILE is absent.
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            let mut combined = std::ffi::OsString::from(drive);
            combined.push(path);
            Some(PathBuf::from(combined))
        })
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn app_store_dir_name(is_debug: bool) -> &'static str {
    if is_debug {
        ".rakh-dev"
    } else {
        ".rakh"
    }
}

pub fn app_store_root_from_home(home: &Path, is_debug: bool) -> PathBuf {
    home.join(app_store_dir_name(is_debug))
}

pub fn app_store_root() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(app_store_root_from_home(&home, cfg!(debug_assertions)))
}

pub fn non_empty_env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn tool_logging_enabled() -> bool {
    structured_tool_logging_enabled()
}

pub fn tool_log(tool: &str, event: &str, fields: Value) {
    structured_tool_log(tool, event, fields);
}

pub fn tool_log_with_context(tool: &str, event: &str, fields: Value, context: Option<&LogContext>) {
    structured_tool_log_with_context(tool, event, fields, context);
}

pub fn truncate_bytes(data: &[u8], max: usize) -> (Vec<u8>, bool) {
    if data.len() <= max {
        (data.to_vec(), false)
    } else {
        (data[..max].to_vec(), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_app_store_dir_name_switches_by_build_type() {
        assert_eq!(app_store_dir_name(true), ".rakh-dev");
        assert_eq!(app_store_dir_name(false), ".rakh");
    }

    #[test]
    fn test_app_store_root_from_home_joins_expected_directory() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            app_store_root_from_home(home, true),
            PathBuf::from("/Users/tester/.rakh-dev")
        );
        assert_eq!(
            app_store_root_from_home(home, false),
            PathBuf::from("/Users/tester/.rakh")
        );
    }
}
