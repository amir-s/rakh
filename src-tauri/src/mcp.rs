use crate::shell_env::resolved_login_shell_env;
use crate::utils::{app_store_root, now_ms, tool_log};
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{CallToolRequestParams, CallToolResult, Tool};
use rmcp::service::RunningService;
use rmcp::transport::{
    streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    TokioChildProcess,
};
use rmcp::{RoleClient, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::time::timeout;

const DEFAULT_MCP_TIMEOUT_MS: u64 = 20_000;
const MCP_CLOSE_TIMEOUT_SECS: u64 = 3;

#[derive(Default)]
pub struct McpRunState {
    runs: tokio::sync::Mutex<HashMap<String, McpRun>>,
}

struct McpRun {
    servers: HashMap<String, Arc<McpServerRuntime>>,
}

struct McpServerRuntime {
    server_name: String,
    timeout_ms: u64,
    client: tokio::sync::Mutex<RunningService<RoleClient, ()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum McpServerRecord {
    Stdio {
        id: String,
        name: String,
        enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        env: HashMap<String, String>,
    },
    StreamableHttp {
        id: String,
        name: String,
        enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
        url: String,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        headers: HashMap<String, String>,
    },
}

impl McpServerRecord {
    fn id(&self) -> &str {
        match self {
            Self::Stdio { id, .. } | Self::StreamableHttp { id, .. } => id,
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Stdio { name, .. } | Self::StreamableHttp { name, .. } => name,
        }
    }

    fn enabled(&self) -> bool {
        match self {
            Self::Stdio { enabled, .. } | Self::StreamableHttp { enabled, .. } => *enabled,
        }
    }

    fn timeout_ms(&self) -> u64 {
        let raw = match self {
            Self::Stdio { timeout_ms, .. } | Self::StreamableHttp { timeout_ms, .. } => {
                *timeout_ms
            }
        };

        match raw {
            Some(0) | None => DEFAULT_MCP_TIMEOUT_MS,
            Some(value) => value,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpSettingsRecord {
    #[serde(default)]
    pub artifactize_returned_files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedMcpConfigRecord {
    #[serde(default)]
    servers: Vec<McpServerRecord>,
    #[serde(default)]
    artifactize_returned_files: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
enum PersistedMcpConfigFile {
    LegacyServers(Vec<McpServerRecord>),
    Config(PersistedMcpConfigRecord),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotationsRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoveredToolRecord {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<McpToolAnnotationsRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerFailureRecord {
    pub server_id: String,
    pub server_name: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPrepareRunResult {
    pub tools: Vec<McpDiscoveredToolRecord>,
    pub failures: Vec<McpServerFailureRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerProbeResult {
    pub server_id: String,
    pub server_name: String,
    pub tools: Vec<McpDiscoveredToolRecord>,
    pub tool_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallResultRecord {
    pub content: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

fn mcp_servers_config_path() -> Result<PathBuf, String> {
    Ok(app_store_root()?.join("config").join("mcp_servers.json"))
}

fn load_mcp_config_from_path(path: &Path) -> Result<PersistedMcpConfigRecord, String> {
    if !path.exists() {
        return Ok(PersistedMcpConfigRecord::default());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("INTERNAL: cannot read MCP servers: {}", error))?;
    let parsed = serde_json::from_str::<PersistedMcpConfigFile>(&raw)
        .map_err(|error| format!("INTERNAL: cannot parse MCP servers: {}", error))?;

    Ok(match parsed {
        PersistedMcpConfigFile::LegacyServers(servers) => PersistedMcpConfigRecord {
            servers,
            ..PersistedMcpConfigRecord::default()
        },
        PersistedMcpConfigFile::Config(config) => config,
    })
}

fn load_mcp_servers_from_path(path: &Path) -> Result<Vec<McpServerRecord>, String> {
    Ok(load_mcp_config_from_path(path)?.servers)
}

fn load_mcp_settings_from_path(path: &Path) -> Result<McpSettingsRecord, String> {
    let config = load_mcp_config_from_path(path)?;
    Ok(McpSettingsRecord {
        artifactize_returned_files: config.artifactize_returned_files,
    })
}

fn save_mcp_config_to_path(path: &Path, config: &PersistedMcpConfigRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("INTERNAL: cannot create config dir: {}", error))?;
    }

    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("INTERNAL: cannot serialise MCP servers: {}", error))?;
    let tmp = path.with_extension(format!("json.tmp-{}", now_ms()));
    fs::write(&tmp, raw.as_bytes())
        .map_err(|error| format!("INTERNAL: cannot write MCP server tmp file: {}", error))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if path.exists() {
                let _ = fs::remove_file(&tmp);
                Ok(())
            } else {
                Err(format!("INTERNAL: cannot rename MCP server file: {}", error))
            }
        }
    }
}

fn save_mcp_servers_to_path(path: &Path, servers: &[McpServerRecord]) -> Result<(), String> {
    let mut config = load_mcp_config_from_path(path)?;
    config.servers = servers.to_vec();
    save_mcp_config_to_path(path, &config)
}

fn save_mcp_settings_to_path(path: &Path, settings: &McpSettingsRecord) -> Result<(), String> {
    let mut config = load_mcp_config_from_path(path)?;
    config.artifactize_returned_files = settings.artifactize_returned_files;
    save_mcp_config_to_path(path, &config)
}

fn tool_annotations_record(tool: &Tool) -> Option<McpToolAnnotationsRecord> {
    tool.annotations.as_ref().map(|annotations| McpToolAnnotationsRecord {
        title: annotations.title.clone(),
        read_only_hint: annotations.read_only_hint,
        destructive_hint: annotations.destructive_hint,
        idempotent_hint: annotations.idempotent_hint,
        open_world_hint: annotations.open_world_hint,
    })
}

fn discovered_tool_record(server: &McpServerRecord, tool: Tool) -> McpDiscoveredToolRecord {
    McpDiscoveredToolRecord {
        server_id: server.id().to_string(),
        server_name: server.name().to_string(),
        name: tool.name.to_string(),
        title: tool.title.clone(),
        description: tool.description.as_ref().map(|value| value.to_string()),
        input_schema: Value::Object((*tool.input_schema).clone()),
        annotations: tool_annotations_record(&tool),
    }
}

fn apply_shell_env(command: &mut tokio::process::Command, env_overrides: &HashMap<String, String>) {
    let shell_env = resolved_login_shell_env();

    if !env_overrides.contains_key("PATH") {
        if let Some(path) = shell_env.path {
            command.env("PATH", path);
        }
    }
    if !env_overrides.contains_key("SHELL") {
        if let Some(shell) = shell_env.shell {
            command.env("SHELL", shell);
        }
    }
    if !env_overrides.contains_key("LANG") {
        if let Some(lang) = shell_env.lang {
            command.env("LANG", lang);
        }
    }
    if !env_overrides.contains_key("LC_ALL") {
        if let Some(value) = shell_env.lc_all {
            command.env("LC_ALL", value);
        }
    }
    if !env_overrides.contains_key("LC_CTYPE") {
        if let Some(value) = shell_env.lc_ctype {
            command.env("LC_CTYPE", value);
        }
    }
}

async fn connect_stdio_server(
    server: &McpServerRecord,
    cwd: &str,
) -> Result<RunningService<RoleClient, ()>, String> {
    let McpServerRecord::Stdio {
        command,
        args,
        env,
        ..
    } = server
    else {
        return Err("Invalid stdio server definition".to_string());
    };

    let mut child_command = tokio::process::Command::new(command);
    child_command
        .args(args)
        .current_dir(cwd)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    apply_shell_env(&mut child_command, env);

    let transport = TokioChildProcess::builder(child_command)
        .stderr(Stdio::inherit())
        .spawn()
        .map(|(transport, _stderr)| transport)
        .map_err(|error| format!("Failed to spawn {}: {}", server.name(), error))?;

    timeout(Duration::from_millis(server.timeout_ms()), ().serve(transport))
        .await
        .map_err(|_| format!("Timed out connecting to {}", server.name()))?
        .map_err(|error| format!("Failed to initialize {}: {}", server.name(), error))
}

fn parse_custom_headers(
    headers: &HashMap<String, String>,
) -> Result<HashMap<HeaderName, HeaderValue>, String> {
    let mut out = HashMap::new();
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("Invalid header name '{}': {}", name, error))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|error| format!("Invalid header value for '{}': {}", name, error))?;
        out.insert(header_name, header_value);
    }
    Ok(out)
}

async fn connect_streamable_http_server(
    server: &McpServerRecord,
) -> Result<RunningService<RoleClient, ()>, String> {
    let McpServerRecord::StreamableHttp { url, headers, .. } = server else {
        return Err("Invalid streamable HTTP server definition".to_string());
    };

    let config = StreamableHttpClientTransportConfig::with_uri(url.clone())
        .custom_headers(parse_custom_headers(headers)?);
    let transport = StreamableHttpClientTransport::from_config(config);

    timeout(Duration::from_millis(server.timeout_ms()), ().serve(transport))
        .await
        .map_err(|_| format!("Timed out connecting to {}", server.name()))?
        .map_err(|error| format!("Failed to initialize {}: {}", server.name(), error))
}

async fn connect_server(
    server: &McpServerRecord,
    cwd: &str,
) -> Result<Arc<McpServerRuntime>, String> {
    let client = match server {
        McpServerRecord::Stdio { .. } => connect_stdio_server(server, cwd).await?,
        McpServerRecord::StreamableHttp { .. } => connect_streamable_http_server(server).await?,
    };

    Ok(Arc::new(McpServerRuntime {
        server_name: server.name().to_string(),
        timeout_ms: server.timeout_ms(),
        client: tokio::sync::Mutex::new(client),
    }))
}

async fn list_tools(
    runtime: &Arc<McpServerRuntime>,
    server: &McpServerRecord,
) -> Result<Vec<McpDiscoveredToolRecord>, String> {
    let client = runtime.client.lock().await;
    let tools = timeout(Duration::from_millis(runtime.timeout_ms), client.peer().list_all_tools())
        .await
        .map_err(|_| format!("Timed out listing tools for {}", runtime.server_name))?
        .map_err(|error| format!("Failed to list tools for {}: {}", runtime.server_name, error))?;

    Ok(tools
        .into_iter()
        .map(|tool| discovered_tool_record(server, tool))
        .collect())
}

async fn close_runtime(runtime: Arc<McpServerRuntime>) {
    let mut client = runtime.client.lock().await;
    let _ = client
        .close_with_timeout(Duration::from_secs(MCP_CLOSE_TIMEOUT_SECS))
        .await;
}

async fn shutdown_run(run: McpRun) {
    for runtime in run.servers.into_values() {
        close_runtime(runtime).await;
    }
}

fn map_call_result(result: CallToolResult) -> McpToolCallResultRecord {
    McpToolCallResultRecord {
        content: result
            .content
            .into_iter()
            .map(|content| serde_json::to_value(content).unwrap_or_else(|_| json!({ "type": "text", "text": "Unable to serialize MCP content." })))
            .collect(),
        structured_content: result.structured_content,
        is_error: result.is_error,
        meta: result.meta.map(|meta| Value::Object(meta.0)),
    }
}

fn input_to_arguments(input: Value) -> Result<Option<Map<String, Value>>, String> {
    match input {
        Value::Null => Ok(None),
        Value::Object(map) => Ok(Some(map)),
        _ => Err("MCP tool input must be a JSON object.".to_string()),
    }
}

#[tauri::command]
pub fn mcp_servers_load() -> Result<Vec<McpServerRecord>, String> {
    tool_log("mcp_servers_load", "start", json!({}));
    let path = mcp_servers_config_path()?;
    let records = load_mcp_servers_from_path(&path)?;
    tool_log("mcp_servers_load", "ok", json!({ "count": records.len() }));
    Ok(records)
}

#[tauri::command]
pub fn mcp_settings_load() -> Result<McpSettingsRecord, String> {
    tool_log("mcp_settings_load", "start", json!({}));
    let path = mcp_servers_config_path()?;
    let settings = load_mcp_settings_from_path(&path)?;
    tool_log(
        "mcp_settings_load",
        "ok",
        json!({ "artifactizeReturnedFiles": settings.artifactize_returned_files }),
    );
    Ok(settings)
}

#[tauri::command]
pub fn mcp_servers_save(servers: Vec<McpServerRecord>) -> Result<(), String> {
    tool_log(
        "mcp_servers_save",
        "start",
        json!({ "count": servers.len() }),
    );
    let path = mcp_servers_config_path()?;
    save_mcp_servers_to_path(&path, &servers)?;
    tool_log("mcp_servers_save", "ok", json!({ "count": servers.len() }));
    Ok(())
}

#[tauri::command]
pub fn mcp_settings_save(settings: McpSettingsRecord) -> Result<(), String> {
    tool_log(
        "mcp_settings_save",
        "start",
        json!({ "artifactizeReturnedFiles": settings.artifactize_returned_files }),
    );
    let path = mcp_servers_config_path()?;
    save_mcp_settings_to_path(&path, &settings)?;
    tool_log(
        "mcp_settings_save",
        "ok",
        json!({ "artifactizeReturnedFiles": settings.artifactize_returned_files }),
    );
    Ok(())
}

#[tauri::command]
pub async fn mcp_test_server(server: McpServerRecord) -> Result<McpServerProbeResult, String> {
    tool_log(
        "mcp_test_server",
        "start",
        json!({ "serverId": server.id(), "serverName": server.name() }),
    );
    let cwd = std::env::current_dir()
        .ok()
        .and_then(|path| path.to_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| ".".to_string());

    let runtime = connect_server(&server, &cwd).await?;
    let tools = list_tools(&runtime, &server).await?;
    close_runtime(runtime).await;

    let result = McpServerProbeResult {
        server_id: server.id().to_string(),
        server_name: server.name().to_string(),
        tool_count: tools.len(),
        tools,
    };

    tool_log(
        "mcp_test_server",
        "ok",
        json!({ "serverId": result.server_id, "toolCount": result.tool_count }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn mcp_prepare_run(
    run_id: String,
    cwd: String,
    servers: Vec<McpServerRecord>,
    state: State<'_, McpRunState>,
) -> Result<McpPrepareRunResult, String> {
    tool_log(
        "mcp_prepare_run",
        "start",
        json!({ "runId": run_id, "cwd": cwd, "serverCount": servers.len() }),
    );

    let mut runtimes = HashMap::new();
    let mut tools = Vec::new();
    let mut failures = Vec::new();

    for server in servers.iter().filter(|server| server.enabled()) {
        match connect_server(server, &cwd).await {
            Ok(runtime) => match list_tools(&runtime, server).await {
                Ok(server_tools) => {
                    tools.extend(server_tools);
                    runtimes.insert(server.id().to_string(), runtime);
                }
                Err(error) => {
                    close_runtime(runtime).await;
                    failures.push(McpServerFailureRecord {
                        server_id: server.id().to_string(),
                        server_name: server.name().to_string(),
                        error,
                    });
                }
            },
            Err(error) => failures.push(McpServerFailureRecord {
                server_id: server.id().to_string(),
                server_name: server.name().to_string(),
                error,
            }),
        }
    }

    let previous = {
        let mut runs = state.runs.lock().await;
        if runtimes.is_empty() {
            runs.remove(&run_id)
        } else {
            runs.insert(run_id.clone(), McpRun { servers: runtimes })
        }
    };
    if let Some(previous) = previous {
        shutdown_run(previous).await;
    }

    tool_log(
        "mcp_prepare_run",
        "ok",
        json!({
            "runId": run_id,
            "toolCount": tools.len(),
            "failureCount": failures.len(),
        }),
    );

    Ok(McpPrepareRunResult { tools, failures })
}

#[tauri::command]
pub async fn mcp_call_tool(
    run_id: String,
    server_id: String,
    tool_name: String,
    input: Value,
    state: State<'_, McpRunState>,
) -> Result<McpToolCallResultRecord, String> {
    let runtime = {
        let runs = state.runs.lock().await;
        runs.get(&run_id)
            .and_then(|run| run.servers.get(&server_id))
            .cloned()
    }
    .ok_or_else(|| format!("MCP server '{}' is not available for run '{}'.", server_id, run_id))?;

    let client = runtime.client.lock().await;
    let mut request = CallToolRequestParams::new(tool_name.clone());
    if let Some(arguments) = input_to_arguments(input)? {
        request = request.with_arguments(arguments);
    }

    let result = timeout(
        Duration::from_millis(runtime.timeout_ms),
        client.peer().call_tool(request),
    )
    .await
    .map_err(|_| {
        format!(
            "Timed out calling MCP tool '{}' on '{}'.",
            tool_name, runtime.server_name
        )
    })?
    .map_err(|error| format!("MCP tool '{}' failed: {}", tool_name, error))?;

    Ok(map_call_result(result))
}

#[tauri::command]
pub async fn mcp_shutdown_run(
    run_id: String,
    state: State<'_, McpRunState>,
) -> Result<(), String> {
    let removed = {
        let mut runs = state.runs.lock().await;
        runs.remove(&run_id)
    };

    if let Some(run) = removed {
        shutdown_run(run).await;
    }

    tool_log("mcp_shutdown_run", "ok", json!({ "runId": run_id }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_servers() -> Vec<McpServerRecord> {
        vec![
            McpServerRecord::Stdio {
                id: "filesystem".to_string(),
                name: "Filesystem".to_string(),
                enabled: true,
                timeout_ms: Some(25_000),
                command: "npx".to_string(),
                args: vec![
                    "-y".to_string(),
                    "@modelcontextprotocol/server-filesystem".to_string(),
                    ".".to_string(),
                ],
                env: HashMap::from([("API_TOKEN".to_string(), "secret".to_string())]),
            },
            McpServerRecord::StreamableHttp {
                id: "docs".to_string(),
                name: "Docs".to_string(),
                enabled: false,
                timeout_ms: None,
                url: "http://localhost:8123/mcp".to_string(),
                headers: HashMap::from([(
                    "Authorization".to_string(),
                    "Bearer token".to_string(),
                )]),
            },
        ]
    }

    #[test]
    fn load_mcp_servers_from_path_returns_empty_when_missing() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("mcp_servers.json");

        let loaded = load_mcp_servers_from_path(&path).expect("load should succeed");

        assert!(loaded.is_empty());
        let settings = load_mcp_settings_from_path(&path).expect("settings load should succeed");
        assert_eq!(
            settings,
            McpSettingsRecord {
                artifactize_returned_files: false,
            }
        );
    }

    #[test]
    fn save_and_load_mcp_servers_round_trip() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("mcp_servers.json");
        let servers = sample_servers();

        save_mcp_servers_to_path(&path, &servers).expect("save should succeed");

        let raw = fs::read_to_string(&path).expect("config file should exist");
        assert!(raw.contains("\"servers\""));
        assert!(raw.contains("\"transport\": \"stdio\""));
        assert!(raw.contains("\"transport\": \"streamable-http\""));
        assert!(raw.contains("\"artifactizeReturnedFiles\": false"));

        let loaded = load_mcp_servers_from_path(&path).expect("load should succeed");
        assert_eq!(loaded, servers);
        let settings = load_mcp_settings_from_path(&path).expect("settings load should succeed");
        assert_eq!(
            settings,
            McpSettingsRecord {
                artifactize_returned_files: false,
            }
        );
    }

    #[test]
    fn save_mcp_settings_preserves_existing_servers() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("mcp_servers.json");
        let servers = sample_servers();

        save_mcp_servers_to_path(&path, &servers).expect("save should succeed");
        save_mcp_settings_to_path(
            &path,
            &McpSettingsRecord {
                artifactize_returned_files: true,
            },
        )
        .expect("settings save should succeed");

        let loaded = load_mcp_servers_from_path(&path).expect("load should succeed");
        assert_eq!(loaded, servers);
        let settings = load_mcp_settings_from_path(&path).expect("settings load should succeed");
        assert_eq!(
            settings,
            McpSettingsRecord {
                artifactize_returned_files: true,
            }
        );
    }

    #[test]
    fn load_mcp_settings_from_legacy_server_array_defaults_to_false() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path().join("config").join("mcp_servers.json");
        let servers = sample_servers();

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("config dir");
        }
        fs::write(
            &path,
            serde_json::to_string_pretty(&servers).expect("serialize legacy servers"),
        )
        .expect("write config");

        let loaded = load_mcp_servers_from_path(&path).expect("load should succeed");
        assert_eq!(loaded, servers);
        let settings = load_mcp_settings_from_path(&path).expect("settings load should succeed");
        assert_eq!(
            settings,
            McpSettingsRecord {
                artifactize_returned_files: false,
            }
        );
    }
}
