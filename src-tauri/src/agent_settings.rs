use crate::utils::{app_store_root, now_ms};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsRecord {
    #[serde(default = "default_warning_threshold")]
    pub warning_threshold: u32,
    #[serde(default = "default_hard_limit")]
    pub hard_limit: u32,
}

impl Default for AgentSettingsRecord {
    fn default() -> Self {
        Self {
            warning_threshold: default_warning_threshold(),
            hard_limit: default_hard_limit(),
        }
    }
}

fn default_warning_threshold() -> u32 {
    40
}

fn default_hard_limit() -> u32 {
    50
}

fn clamp_positive(value: u32, fallback: u32) -> u32 {
    if value == 0 {
        fallback
    } else {
        value
    }
}

fn normalize_agent_settings(mut settings: AgentSettingsRecord) -> AgentSettingsRecord {
    settings.hard_limit = clamp_positive(settings.hard_limit, default_hard_limit()).max(2);
    settings.warning_threshold =
        clamp_positive(settings.warning_threshold, default_warning_threshold()).max(1);

    if settings.warning_threshold >= settings.hard_limit {
        settings.warning_threshold = settings.hard_limit.saturating_sub(1).max(1);
    }

    settings
}

fn agent_settings_config_path() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("config").join("agent.json"))
}

fn load_agent_settings_from_path(path: &Path) -> Result<AgentSettingsRecord, String> {
    if !path.exists() {
        return Ok(AgentSettingsRecord::default());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("INTERNAL: cannot read agent settings: {}", error))?;

    let parsed = match serde_json::from_str::<AgentSettingsRecord>(&raw) {
        Ok(settings) => settings,
        Err(_) => AgentSettingsRecord::default(),
    };

    Ok(normalize_agent_settings(parsed))
}

fn save_agent_settings_to_path(path: &Path, settings: &AgentSettingsRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create config dir: {}", error))?;
    }

    let normalized = normalize_agent_settings(settings.clone());
    let raw = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("INTERNAL: cannot serialise agent settings: {}", error))?;
    let tmp = path.with_extension(format!("json.tmp-{}", now_ms()));
    fs::write(&tmp, raw.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write agent settings tmp file: {}", error))?;

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if path.exists() {
                let _ = fs::remove_file(&tmp);
                Ok(())
            } else {
                Err(format!(
                    "INTERNAL: cannot rename agent settings file: {}",
                    error
                ))
            }
        }
    }
}

#[tauri::command]
pub fn agent_settings_load() -> Result<AgentSettingsRecord, String> {
    let path = agent_settings_config_path()?;
    load_agent_settings_from_path(&path)
}

#[tauri::command]
pub fn agent_settings_save(settings: AgentSettingsRecord) -> Result<(), String> {
    let path = agent_settings_config_path()?;
    save_agent_settings_to_path(&path, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_returns_defaults_when_file_is_missing() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("agent.json");

        let settings = load_agent_settings_from_path(&path).expect("load defaults");

        assert_eq!(settings, AgentSettingsRecord::default());
    }

    #[test]
    fn save_and_load_round_trip_settings() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("agent.json");
        let settings = AgentSettingsRecord {
            warning_threshold: 80,
            hard_limit: 120,
        };

        save_agent_settings_to_path(&path, &settings).expect("save settings");
        let loaded = load_agent_settings_from_path(&path).expect("load settings");

        assert_eq!(loaded, settings);
    }

    #[test]
    fn load_falls_back_to_defaults_for_invalid_json() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("agent.json");
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        fs::write(&path, b"{ definitely invalid json").expect("write invalid file");

        let loaded = load_agent_settings_from_path(&path).expect("load settings");

        assert_eq!(loaded, AgentSettingsRecord::default());
    }

    #[test]
    fn save_normalizes_invalid_threshold_pairs() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("agent.json");
        let settings = AgentSettingsRecord {
            warning_threshold: 500,
            hard_limit: 1,
        };

        save_agent_settings_to_path(&path, &settings).expect("save settings");
        let loaded = load_agent_settings_from_path(&path).expect("load settings");

        assert_eq!(
            loaded,
            AgentSettingsRecord {
                warning_threshold: 1,
                hard_limit: 2,
            }
        );
    }

    #[test]
    fn load_normalizes_partial_records() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("agent.json");
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        fs::write(&path, br#"{ "hardLimit": 75 }"#).expect("write file");

        let loaded = load_agent_settings_from_path(&path).expect("load settings");

        assert_eq!(
            loaded,
            AgentSettingsRecord {
                warning_threshold: default_warning_threshold(),
                hard_limit: 75,
            }
        );
    }
}
