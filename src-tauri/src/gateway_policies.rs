use crate::utils::{app_store_root, now_ms, tool_log};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HugeOutputThresholdBandRecord {
    pub min_context_usage_pct: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HugeOutputPolicyRecord {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_huge_output_threshold_bytes")]
    pub default_threshold_bytes: u64,
    #[serde(default = "default_huge_output_threshold_bands")]
    pub threshold_bands: Vec<HugeOutputThresholdBandRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPolicyRecord {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_summary_model_strategy")]
    pub model_strategy: String,
    #[serde(default)]
    pub override_model_id: Option<String>,
    #[serde(default = "default_summary_max_chars")]
    pub max_summary_chars: u64,
    #[serde(default = "default_summary_max_steps")]
    pub max_steps: u64,
    #[serde(default = "default_summary_artifact_get_max_bytes")]
    pub tool_artifact_get_max_bytes: u64,
    #[serde(default = "default_summary_artifact_search_max_matches")]
    pub tool_artifact_search_max_matches: u64,
    #[serde(default = "default_summary_artifact_search_context_lines")]
    pub tool_artifact_search_context_lines: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolGatewayPolicyConfigRecord {
    #[serde(default)]
    pub huge_output: HugeOutputPolicyRecord,
    #[serde(default)]
    pub summary: SummaryPolicyRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoNormalizationPolicyRecord {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_context_trigger_pct")]
    pub trigger_min_context_usage_pct: u64,
    #[serde(default = "default_true")]
    pub replace_api_messages_after_compaction: bool,
    #[serde(default = "default_context_model_strategy")]
    pub model_strategy: String,
    #[serde(default = "default_context_override_model_id")]
    pub override_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextGatewayPolicyConfigRecord {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub todo_normalization: TodoNormalizationPolicyRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPolicySettingsRecord {
    #[serde(default)]
    pub tool_gateway: ToolGatewayPolicyConfigRecord,
    #[serde(default)]
    pub context_gateway: ContextGatewayPolicyConfigRecord,
}

fn default_true() -> bool {
    true
}

fn default_huge_output_threshold_bytes() -> u64 {
    64 * 1024
}

fn default_huge_output_threshold_bands() -> Vec<HugeOutputThresholdBandRecord> {
    vec![
        HugeOutputThresholdBandRecord {
            min_context_usage_pct: 90,
            max_bytes: 16 * 1024,
        },
        HugeOutputThresholdBandRecord {
            min_context_usage_pct: 75,
            max_bytes: 32 * 1024,
        },
    ]
}

fn default_summary_model_strategy() -> String {
    "parent".to_string()
}

fn default_summary_max_chars() -> u64 {
    320
}

fn default_summary_max_steps() -> u64 {
    5
}

fn default_summary_artifact_get_max_bytes() -> u64 {
    12_000
}

fn default_summary_artifact_search_max_matches() -> u64 {
    8
}

fn default_summary_artifact_search_context_lines() -> u64 {
    1
}

fn default_context_trigger_pct() -> u64 {
    75
}

fn default_context_model_strategy() -> String {
    "override".to_string()
}

fn default_context_override_model_id() -> Option<String> {
    Some("openai/gpt-5.2-codex".to_string())
}

impl Default for HugeOutputPolicyRecord {
    fn default() -> Self {
        Self {
            enabled: true,
            default_threshold_bytes: default_huge_output_threshold_bytes(),
            threshold_bands: default_huge_output_threshold_bands(),
        }
    }
}

impl Default for SummaryPolicyRecord {
    fn default() -> Self {
        Self {
            enabled: true,
            model_strategy: default_summary_model_strategy(),
            override_model_id: None,
            max_summary_chars: default_summary_max_chars(),
            max_steps: default_summary_max_steps(),
            tool_artifact_get_max_bytes: default_summary_artifact_get_max_bytes(),
            tool_artifact_search_max_matches: default_summary_artifact_search_max_matches(),
            tool_artifact_search_context_lines: default_summary_artifact_search_context_lines(),
        }
    }
}

impl Default for ToolGatewayPolicyConfigRecord {
    fn default() -> Self {
        Self {
            huge_output: HugeOutputPolicyRecord::default(),
            summary: SummaryPolicyRecord::default(),
        }
    }
}

impl Default for TodoNormalizationPolicyRecord {
    fn default() -> Self {
        Self {
            enabled: true,
            trigger_min_context_usage_pct: default_context_trigger_pct(),
            replace_api_messages_after_compaction: true,
            model_strategy: default_context_model_strategy(),
            override_model_id: default_context_override_model_id(),
        }
    }
}

impl Default for ContextGatewayPolicyConfigRecord {
    fn default() -> Self {
        Self {
            enabled: true,
            todo_normalization: TodoNormalizationPolicyRecord::default(),
        }
    }
}

impl Default for GatewayPolicySettingsRecord {
    fn default() -> Self {
        Self {
            tool_gateway: ToolGatewayPolicyConfigRecord::default(),
            context_gateway: ContextGatewayPolicyConfigRecord::default(),
        }
    }
}

fn gateway_policies_config_path() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("config").join("gateway_policies.json"))
}

fn load_gateway_policies_from_path(path: &Path) -> Result<GatewayPolicySettingsRecord, String> {
    if !path.exists() {
        return Ok(GatewayPolicySettingsRecord::default());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("INTERNAL: cannot read gateway policies: {}", error))?;
    serde_json::from_str::<GatewayPolicySettingsRecord>(&raw)
        .map_err(|error| format!("INTERNAL: cannot parse gateway policies: {}", error))
}

fn save_gateway_policies_to_path(
    path: &Path,
    settings: &GatewayPolicySettingsRecord,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create config dir: {}", error))?;
    }

    let raw = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("INTERNAL: cannot serialise gateway policies: {}", error))?;
    let tmp = path.with_extension(format!("json.tmp-{}", now_ms()));
    fs::write(&tmp, raw.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write gateway policies tmp file: {}", error))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if path.exists() {
                let _ = fs::remove_file(&tmp);
                Ok(())
            } else {
                Err(format!(
                    "INTERNAL: cannot rename gateway policies file: {}",
                    error
                ))
            }
        }
    }
}

#[tauri::command]
pub fn gateway_policy_settings_load() -> Result<GatewayPolicySettingsRecord, String> {
    tool_log("gateway_policy_settings_load", "start", json!({}));
    let path = gateway_policies_config_path()?;
    let settings = load_gateway_policies_from_path(&path)?;
    tool_log(
        "gateway_policy_settings_load",
        "ok",
        json!({
            "toolHugeOutputEnabled": settings.tool_gateway.huge_output.enabled,
            "contextGatewayEnabled": settings.context_gateway.enabled,
        }),
    );
    Ok(settings)
}

#[tauri::command]
pub fn gateway_policy_settings_save(
    settings: GatewayPolicySettingsRecord,
) -> Result<(), String> {
    tool_log(
        "gateway_policy_settings_save",
        "start",
        json!({
            "toolHugeOutputEnabled": settings.tool_gateway.huge_output.enabled,
            "contextGatewayEnabled": settings.context_gateway.enabled,
        }),
    );
    let path = gateway_policies_config_path()?;
    save_gateway_policies_to_path(&path, &settings)?;
    tool_log(
        "gateway_policy_settings_save",
        "ok",
        json!({
            "toolHugeOutputEnabled": settings.tool_gateway.huge_output.enabled,
            "contextGatewayEnabled": settings.context_gateway.enabled,
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn load_gateway_policies_defaults_when_missing() {
      let dir = tempdir().expect("tempdir should succeed");
      let path = dir.path().join("gateway_policies.json");
      let loaded = load_gateway_policies_from_path(&path).expect("load should succeed");
      assert_eq!(loaded, GatewayPolicySettingsRecord::default());
    }

    #[test]
    fn load_gateway_policies_applies_defaults_for_missing_fields() {
      let dir = tempdir().expect("tempdir should succeed");
      let path = dir.path().join("gateway_policies.json");
      fs::write(
        &path,
        r#"{
          "toolGateway": {
            "summary": {
              "enabled": false
            }
          }
        }"#,
      )
      .expect("write should succeed");

      let loaded = load_gateway_policies_from_path(&path).expect("load should succeed");
      assert_eq!(loaded.tool_gateway.summary.enabled, false);
      assert_eq!(
        loaded.tool_gateway.huge_output.default_threshold_bytes,
        default_huge_output_threshold_bytes()
      );
      assert_eq!(loaded.context_gateway, ContextGatewayPolicyConfigRecord::default());
    }

    #[test]
    fn save_gateway_policies_round_trips() {
      let dir = tempdir().expect("tempdir should succeed");
      let path = dir.path().join("gateway_policies.json");
      let settings = GatewayPolicySettingsRecord {
        tool_gateway: ToolGatewayPolicyConfigRecord {
          huge_output: HugeOutputPolicyRecord {
            enabled: false,
            default_threshold_bytes: 2048,
            threshold_bands: vec![HugeOutputThresholdBandRecord {
              min_context_usage_pct: 80,
              max_bytes: 1024,
            }],
          },
          summary: SummaryPolicyRecord {
            enabled: true,
            model_strategy: "override".to_string(),
            override_model_id: Some("openai/gpt-5.2-mini".to_string()),
            max_summary_chars: 222,
            max_steps: 4,
            tool_artifact_get_max_bytes: 1234,
            tool_artifact_search_max_matches: 5,
            tool_artifact_search_context_lines: 2,
          },
        },
        context_gateway: ContextGatewayPolicyConfigRecord {
          enabled: false,
          todo_normalization: TodoNormalizationPolicyRecord {
            enabled: true,
            trigger_min_context_usage_pct: 88,
            replace_api_messages_after_compaction: false,
            model_strategy: "parent".to_string(),
            override_model_id: None,
          },
        },
      };

      save_gateway_policies_to_path(&path, &settings).expect("save should succeed");
      let loaded = load_gateway_policies_from_path(&path).expect("load should succeed");
      assert_eq!(loaded, settings);
      assert!(Path::new(&path).exists());
    }
}
