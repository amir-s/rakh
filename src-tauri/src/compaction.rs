use crate::utils::{app_store_root, now_ms};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoContextCompactionSettingsRecord {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_threshold_mode")]
    pub threshold_mode: String,
    #[serde(default = "default_threshold_percent")]
    pub threshold_percent: u32,
    #[serde(default = "default_threshold_kb")]
    pub threshold_kb: u32,
}

impl Default for AutoContextCompactionSettingsRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_mode: default_threshold_mode(),
            threshold_percent: default_threshold_percent(),
            threshold_kb: default_threshold_kb(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettingsRecord {
    #[serde(default = "default_tool_context_compaction_enabled")]
    pub tool_context_compaction_enabled: bool,
    #[serde(default)]
    pub auto_context_compaction: AutoContextCompactionSettingsRecord,
}

impl Default for CompactionSettingsRecord {
    fn default() -> Self {
        Self {
            tool_context_compaction_enabled: default_tool_context_compaction_enabled(),
            auto_context_compaction: AutoContextCompactionSettingsRecord::default(),
        }
    }
}

fn default_tool_context_compaction_enabled() -> bool {
    true
}

fn default_threshold_mode() -> String {
    "percentage".to_string()
}

fn default_threshold_percent() -> u32 {
    85
}

fn default_threshold_kb() -> u32 {
    256
}

fn normalize_threshold_mode(value: &str) -> String {
    if value == "kb" {
        "kb".to_string()
    } else {
        "percentage".to_string()
    }
}

fn clamp_threshold(value: u32, minimum: u32, maximum: u32, fallback: u32) -> u32 {
    let next = if value == 0 { fallback } else { value };
    next.clamp(minimum, maximum)
}

fn normalize_compaction_settings(
    mut settings: CompactionSettingsRecord,
) -> CompactionSettingsRecord {
    settings.auto_context_compaction.threshold_mode =
        normalize_threshold_mode(&settings.auto_context_compaction.threshold_mode);
    settings.auto_context_compaction.threshold_percent = clamp_threshold(
        settings.auto_context_compaction.threshold_percent,
        1,
        100,
        default_threshold_percent(),
    );
    settings.auto_context_compaction.threshold_kb = clamp_threshold(
        settings.auto_context_compaction.threshold_kb,
        1,
        1_048_576,
        default_threshold_kb(),
    );
    settings
}

fn compaction_config_path() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("config").join("compaction.json"))
}

fn load_compaction_settings_from_path(path: &Path) -> Result<CompactionSettingsRecord, String> {
    if !path.exists() {
        return Ok(CompactionSettingsRecord::default());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("INTERNAL: cannot read compaction settings: {}", error))?;
    let parsed = serde_json::from_str::<CompactionSettingsRecord>(&raw)
        .map_err(|error| format!("INTERNAL: cannot parse compaction settings: {}", error))?;
    Ok(normalize_compaction_settings(parsed))
}

fn save_compaction_settings_to_path(
    path: &Path,
    settings: &CompactionSettingsRecord,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create config dir: {}", error))?;
    }

    let normalized = normalize_compaction_settings(settings.clone());
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("INTERNAL: cannot serialise compaction settings: {}", error))?;
    let tmp = path.with_extension(format!("json.tmp-{}", now_ms()));
    fs::write(&tmp, raw.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write compaction tmp file: {}", error))?;

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if path.exists() {
                let _ = fs::remove_file(&tmp);
                Ok(())
            } else {
                Err(format!(
                    "INTERNAL: cannot rename compaction settings file: {}",
                    error
                ))
            }
        }
    }
}

#[tauri::command]
pub fn compaction_settings_load() -> Result<CompactionSettingsRecord, String> {
    let path = compaction_config_path()?;
    load_compaction_settings_from_path(&path)
}

#[tauri::command]
pub fn compaction_settings_save(settings: CompactionSettingsRecord) -> Result<(), String> {
    let path = compaction_config_path()?;
    save_compaction_settings_to_path(&path, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_returns_defaults_when_file_is_missing() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("compaction.json");

        let settings = load_compaction_settings_from_path(&path).expect("load defaults");

        assert_eq!(settings, CompactionSettingsRecord::default());
    }

    #[test]
    fn save_and_load_round_trip_settings() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("compaction.json");
        let settings = CompactionSettingsRecord {
            tool_context_compaction_enabled: false,
            auto_context_compaction: AutoContextCompactionSettingsRecord {
                enabled: true,
                threshold_mode: "kb".to_string(),
                threshold_percent: 90,
                threshold_kb: 512,
            },
        };

        save_compaction_settings_to_path(&path, &settings).expect("save settings");
        let loaded = load_compaction_settings_from_path(&path).expect("load settings");

        assert_eq!(loaded, settings);
    }

    #[test]
    fn save_normalizes_invalid_threshold_values() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("compaction.json");
        let settings = CompactionSettingsRecord {
            tool_context_compaction_enabled: true,
            auto_context_compaction: AutoContextCompactionSettingsRecord {
                enabled: true,
                threshold_mode: "invalid".to_string(),
                threshold_percent: 0,
                threshold_kb: 0,
            },
        };

        save_compaction_settings_to_path(&path, &settings).expect("save settings");
        let loaded = load_compaction_settings_from_path(&path).expect("load settings");

        assert_eq!(
            loaded,
            CompactionSettingsRecord {
                tool_context_compaction_enabled: true,
                auto_context_compaction: AutoContextCompactionSettingsRecord {
                    enabled: true,
                    threshold_mode: "percentage".to_string(),
                    threshold_percent: default_threshold_percent(),
                    threshold_kb: default_threshold_kb(),
                },
            }
        );
    }
}
