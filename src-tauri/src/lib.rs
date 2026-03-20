pub mod agent_settings;
pub mod cli;
pub mod codex;
pub mod compaction;
pub mod db;
pub mod exec;
pub mod external_tools;
pub mod fs_ops;
pub mod git;
pub mod logging;
pub mod mcp;
pub mod pty;
pub mod shell_env;
pub mod todos;
pub mod utils;
pub mod whisper;

use db::{init_db, AppState};
use logging::init_runtime_logging;
use mcp::McpRunState;
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = init_db().expect("Failed to initialise sessions database");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            cli::handle_secondary_cli_invocation(app, argv);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            init_runtime_logging(app.handle().clone())?;
            if let Err(error) = cli::refresh_installed_launcher_if_needed() {
                eprintln!("Failed to refresh installed rakh launcher: {error}");
            }
            cli::capture_startup_cli_request(app.handle());
            Ok(())
        })
        .manage(AppState {
            pty_writers: Mutex::new(HashMap::new()),
            pty_masters: Mutex::new(HashMap::new()),
            db: Mutex::new(db),
            todo_locks: Mutex::new(HashMap::new()),
        })
        .manage(cli::CliState::default())
        .manage(McpRunState::default())
        .invoke_handler(tauri::generate_handler![
            cli::cli_get_status,
            cli::cli_install,
            cli::cli_uninstall,
            cli::cli_take_pending_requests,
            codex::codex_get_status,
            codex::codex_session_start,
            codex::codex_session_send_turn,
            codex::codex_session_interrupt,
            codex::codex_session_close,
            db::load_provider_env_api_keys,
            git::git_worktree_add,
            fs_ops::list_dir,
            fs_ops::stat_file,
            fs_ops::read_file,
            fs_ops::read_file_base64,
            fs_ops::write_file,
            fs_ops::delete_file,
            fs_ops::glob_files,
            fs_ops::search_files,
            fs_ops::search_files_grep,
            whisper::whisper_prepare_model,
            whisper::whisper_transcribe_wav,
            exec::exec_run,
            exec::exec_abort,
            exec::exec_stop,
            todos::todo_store_load,
            todos::todo_store_replace,
            todos::todo_store_add,
            todos::todo_store_update,
            todos::todo_store_remove,
            todos::todo_store_note_add,
            todos::todo_store_record_mutation,
            todos::todo_store_get_path,
            external_tools::open_in_editor,
            external_tools::open_editor_reference,
            external_tools::open_shell,
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            db::db_load_sessions,
            db::db_upsert_session,
            db::db_archive_session,
            db::db_set_session_pinned,
            db::db_load_archived_sessions,
            db::db_delete_session,
            db::db_artifact_create,
            db::db_artifact_version,
            db::db_artifact_get,
            db::db_artifact_list,
            db::db_artifact_clone_session,
            db::providers_load,
            db::providers_save,
            db::projects_load,
            db::projects_save,
            db::profiles_load,
            db::profiles_save,
            db::command_list_load,
            db::command_list_save,
            logging::logs_write,
            logging::logs_query,
            logging::logs_export,
            logging::logs_clear,
            agent_settings::agent_settings_load,
            agent_settings::agent_settings_save,
            compaction::compaction_settings_load,
            compaction::compaction_settings_save,
            mcp::mcp_servers_load,
            mcp::mcp_settings_load,
            mcp::mcp_servers_save,
            mcp::mcp_settings_save,
            mcp::mcp_test_server,
            mcp::mcp_prepare_run,
            mcp::mcp_call_tool,
            mcp::mcp_shutdown_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
