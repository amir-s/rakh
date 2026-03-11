use crate::utils::{app_store_root, tool_log};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

fn sanitize_repo_slug_segment(segment: &str) -> Option<String> {
    let mut out = String::new();
    let mut prev_dash = false;

    for ch in segment.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }

    let trimmed = out.trim_matches(|ch| ch == '-' || ch == '_' || ch == '.');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn sanitize_repo_slug(repo_slug: &str) -> String {
    let segments = repo_slug
        .split('/')
        .filter_map(sanitize_repo_slug_segment)
        .collect::<Vec<_>>();

    if segments.is_empty() {
        "repo".to_string()
    } else {
        segments.join("/")
    }
}

fn derive_worktree_path(app_root: &Path, repo_slug: &str, branch: &str) -> Result<PathBuf, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("INVALID_ARGUMENT: branch must not be empty".to_string());
    }

    let branch_path = Path::new(branch);
    if branch_path.is_absolute() {
        return Err("INVALID_ARGUMENT: branch must be a relative path".to_string());
    }

    let mut out = app_root.join("worktrees");
    for segment in sanitize_repo_slug(repo_slug).split('/') {
        out.push(segment);
    }

    for component in branch_path.components() {
        match component {
            Component::Normal(segment) => out.push(segment),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(
                    "INVALID_ARGUMENT: branch must not contain parent traversal".to_string()
                );
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("INVALID_ARGUMENT: branch must be a relative path".to_string());
            }
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn git_worktree_add(
    repo_path: String,
    repo_slug: String,
    branch: String,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log(
        "git_worktree_add",
        "start",
        json!({
            "repoPath": repo_path,
            "repoSlug": repo_slug,
            "branch": branch
        }),
    );

    let result: Result<Value, String> = (|| {
        let worktree_path = derive_worktree_path(&app_store_root()?, &repo_slug, &branch)?;
        let worktree_path_str = worktree_path.to_string_lossy().to_string();

        // Ensure the parent directory exists
        if let Some(parent) = worktree_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create worktree parent dir: {}", e))?;
        }

        let add_output = std::process::Command::new("git")
            .args([
                "-C",
                &repo_path,
                "worktree",
                "add",
                &worktree_path_str,
                "-b",
                &branch,
            ])
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr).to_string();
            Err(format!("git worktree add failed: {}", stderr.trim()))
        } else {
            let detach_output = std::process::Command::new("git")
                .args(["-C", &worktree_path_str, "switch", "--detach"])
                .output()
                .map_err(|e| format!("Failed to run git detach: {}", e))?;

            if detach_output.status.success() {
                Ok(json!({
                    "path": worktree_path_str,
                    "branch": branch
                }))
            } else {
                let stderr = String::from_utf8_lossy(&detach_output.stderr).to_string();
                Err(format!("git worktree detach failed: {}", stderr.trim()))
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_worktree_path_uses_app_store_root() {
        let app_root = Path::new("/Users/test/.rakh-dev");
        let path = derive_worktree_path(app_root, "owner/repo", "feature/name").unwrap();
        assert_eq!(
            path,
            PathBuf::from("/Users/test/.rakh-dev/worktrees/owner/repo/feature/name")
        );
    }

    #[test]
    fn test_derive_worktree_path_sanitizes_repo_slug_without_escaping_root() {
        let app_root = Path::new("/Users/test/.rakh-dev");
        let path = derive_worktree_path(app_root, "../../bad slug///repo.git", "feature").unwrap();
        assert_eq!(
            path,
            PathBuf::from("/Users/test/.rakh-dev/worktrees/bad-slug/repo.git/feature")
        );
        assert!(path.starts_with(app_root.join("worktrees")));
    }

    #[test]
    fn test_derive_worktree_path_rejects_parent_traversal_in_branch() {
        let app_root = Path::new("/Users/test/.rakh-dev");
        let err = derive_worktree_path(app_root, "owner/repo", "../feature").unwrap_err();
        assert!(err.contains("parent traversal"));
    }
}
