use crate::utils::tool_log;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

#[tauri::command]
pub fn git_worktree_add(
    repo_path: String,
    worktree_path: String,
    branch: String,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log(
        "git_worktree_add",
        "start",
        json!({
            "repoPath": repo_path,
            "worktreePath": worktree_path,
            "branch": branch
        }),
    );

    let result: Result<Value, String> = (|| {
        // Ensure the parent directory exists
        let wt_path = PathBuf::from(&worktree_path);
        if let Some(parent) = wt_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create worktree parent dir: {}", e))?;
        }

        let output = std::process::Command::new("git")
            .args([
                "-C",
                &repo_path,
                "worktree",
                "add",
                &worktree_path,
                "-b",
                &branch,
            ])
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if output.status.success() {
            Ok(json!({ "path": worktree_path, "branch": branch }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("git worktree add failed: {}", stderr.trim()))
        }
    })();

    match &result {
        Ok(v) => tool_log(
            "git_worktree_add",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "path": v["path"],
                "branch": v["branch"]
            }),
        ),
        Err(e) => tool_log(
            "git_worktree_add",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}
