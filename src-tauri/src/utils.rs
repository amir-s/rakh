use serde_json::{json, Value};
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
    // In dev builds, default to on for easier debugging.
    // In release builds, require opt-in via env var.
    if cfg!(debug_assertions) {
        return true;
    }
    std::env::var("RAKH_TOOL_LOG")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        })
        .unwrap_or(false)
}

pub fn tool_log(tool: &str, event: &str, fields: Value) {
    if !tool_logging_enabled() {
        return;
    }

    let mut obj = serde_json::Map::new();
    obj.insert("tsMs".to_string(), json!(now_ms()));
    obj.insert("tool".to_string(), json!(tool));
    obj.insert("event".to_string(), json!(event));

    if let Value::Object(map) = fields {
        for (k, v) in map {
            obj.insert(k, v);
        }
    } else {
        obj.insert("data".to_string(), fields);
    }

    // JSONL (one object per line) for easy grepping and ingestion.
    eprintln!("{}", Value::Object(obj).to_string());
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
