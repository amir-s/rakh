use crate::logging::LogContext;
use crate::utils::{tool_log, tool_log_with_context};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, Read};
use std::path::PathBuf;
use std::time::{Instant, UNIX_EPOCH};

#[tauri::command]
pub fn list_dir(
    path: String,
    include_hidden: bool,
    max_entries: usize,
    log_context: Option<LogContext>,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log_with_context(
        "list_dir",
        "start",
        json!({
            "path": path,
            "includeHidden": include_hidden,
            "maxEntries": max_entries
        }),
        log_context.as_ref(),
    );

    let result: Result<Value, String> = (|| {
        let dir = PathBuf::from(&path);
        let entries_iter =
            fs::read_dir(&dir).map_err(|e| format!("Cannot read dir {}: {}", path, e))?;

        let mut entries: Vec<Value> = Vec::new();
        let mut truncated = false;

        for entry in entries_iter {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !include_hidden && name.starts_with('.') && name != ".github" {
                continue;
            }
            if entries.len() >= max_entries {
                truncated = true;
                break;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let kind = if meta.file_type().is_symlink() {
                "symlink"
            } else if meta.is_dir() {
                "dir"
            } else {
                "file"
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let mut obj = json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
                "kind": kind,
            });
            if kind == "file" {
                obj["sizeBytes"] = json!(meta.len());
            }
            if let Some(ms) = mtime_ms {
                obj["mtimeMs"] = json!(ms);
            }
            entries.push(obj);
        }
        Ok(json!({ "path": path, "entries": entries, "truncated": truncated }))
    })();

    match &result {
        Ok(v) => tool_log_with_context(
            "list_dir",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "entryCount": v["entries"].as_array().map(|a| a.len()).unwrap_or(0),
                "truncated": v["truncated"]
            }),
            log_context.as_ref(),
        ),
        Err(e) => tool_log_with_context(
            "list_dir",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn stat_file(path: String, log_context: Option<LogContext>) -> Result<Value, String> {
    let start = Instant::now();
    tool_log_with_context(
        "stat_file",
        "start",
        json!({ "path": path }),
        log_context.as_ref(),
    );

    let result: Result<Value, String> = (|| {
        let p = PathBuf::from(&path);
        if let Ok(meta) = fs::metadata(&p) {
            let kind = if meta.file_type().is_symlink() {
                "symlink"
            } else if meta.is_dir() {
                "dir"
            } else {
                "file"
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            let mut obj = json!({
                "exists": true,
                "path": path,
                "kind": kind,
            });
            if kind == "file" {
                obj["sizeBytes"] = json!(meta.len());
            }
            if let Some(ms) = mtime_ms {
                obj["mtimeMs"] = json!(ms);
            }
            Ok(obj)
        } else {
            Ok(json!({ "exists": false, "path": path }))
        }
    })();

    match &result {
        Ok(v) => tool_log_with_context(
            "stat_file",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "exists": v["exists"],
                "kind": v.get("kind").cloned().unwrap_or(json!(null))
            }),
            log_context.as_ref(),
        ),
        Err(e) => tool_log_with_context(
            "stat_file",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn read_file(
    path: String,
    start_line: Option<u64>,
    end_line: Option<u64>,
    max_bytes: u64,
    log_context: Option<LogContext>,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log_with_context(
        "read_file",
        "start",
        json!({
            "path": path,
            "startLine": start_line,
            "endLine": end_line,
            "maxBytes": max_bytes
        }),
        log_context.as_ref(),
    );

    let result: Result<Value, String> = (|| {
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p).map_err(|_| format!("NOT_FOUND: {}", path))?;
        let file_size = meta.len();

        let file = fs::File::open(&p).map_err(|e| format!("Cannot open {}: {}", path, e))?;

        let (content, truncated, line_count, used_range) =
            if start_line.is_some() || end_line.is_some() {
                let s = start_line.unwrap_or(1).max(1) as usize;
                let e_line = end_line.unwrap_or(u64::MAX) as usize;
                let mut lines: Vec<String> = Vec::new();
                let mut total_lines = 0usize;
                let mut bytes_used = 0u64;
                let mut trunc = false;
                for (i, line) in io::BufReader::new(file).lines().enumerate() {
                    total_lines += 1;
                    let ln = line.map_err(|e| e.to_string())?;
                    if i + 1 >= s && i + 1 <= e_line {
                        bytes_used += ln.len() as u64 + 1;
                        if bytes_used > max_bytes {
                            trunc = true;
                            break;
                        }
                        lines.push(ln);
                    }
                }
                let content = lines.join("\n");
                (
                    content,
                    trunc,
                    Some(total_lines),
                    Some((s, e_line.min(s + lines.len().saturating_sub(1)))),
                )
            } else {
                // Read up to max_bytes
                let to_read = file_size.min(max_bytes) as usize;
                let mut buf = vec![0u8; to_read];
                let mut reader = io::BufReader::new(file);
                let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
                buf.truncate(n);
                let content = String::from_utf8_lossy(&buf).to_string();
                let trunc = file_size > max_bytes;
                (content, trunc, None, None)
            };

        let mut result = json!({
            "path": path,
            "encoding": "utf8",
            "content": content,
            "fileSizeBytes": file_size,
            "truncated": truncated,
        });
        if let Some(lc) = line_count {
            result["lineCount"] = json!(lc);
        }
        if let Some((s, e)) = used_range {
            result["range"] = json!({ "startLine": s, "endLine": e });
        }
        Ok(result)
    })();

    match &result {
        Ok(v) => tool_log_with_context(
            "read_file",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "fileSizeBytes": v["fileSizeBytes"],
                "truncated": v["truncated"],
                "contentBytes": v["content"].as_str().map(|s| s.len()).unwrap_or(0)
            }),
            log_context.as_ref(),
        ),
        Err(e) => tool_log_with_context(
            "read_file",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    mode: String,
    create_dirs: bool,
    log_context: Option<LogContext>,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log_with_context(
        "write_file",
        "start",
        json!({
            "path": path,
            "mode": mode,
            "createDirs": create_dirs,
            "contentBytes": content.as_bytes().len()
        }),
        log_context.as_ref(),
    );

    let result: Result<Value, String> = (|| {
        let p = PathBuf::from(&path);
        let exists = p.exists();

        match mode.as_str() {
            "create" if exists => {
                return Err(format!("CONFLICT: file already exists: {}", path));
            }
            _ => {}
        }

        if create_dirs {
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }

        let bytes = content.as_bytes();
        fs::write(&p, bytes).map_err(|e| format!("Cannot write {}: {}", path, e))?;

        Ok(json!({
            "path": path,
            "bytesWritten": bytes.len(),
            "created": !exists,
            "overwritten": exists,
        }))
    })();

    match &result {
        Ok(v) => tool_log_with_context(
            "write_file",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "bytesWritten": v["bytesWritten"],
                "created": v["created"],
                "overwritten": v["overwritten"]
            }),
            log_context.as_ref(),
        ),
        Err(e) => tool_log_with_context(
            "write_file",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let start = Instant::now();
    tool_log("delete_file", "start", json!({ "path": path }));

    let result: Result<(), String> =
        (|| fs::remove_file(&path).map_err(|e| format!("Cannot delete {}: {}", path, e)))();

    match &result {
        Ok(()) => tool_log(
            "delete_file",
            "ok",
            json!({ "durationMs": start.elapsed().as_millis() as u64 }),
        ),
        Err(e) => tool_log(
            "delete_file",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn glob_files(
    patterns: Vec<String>,
    cwd: String,
    max_matches: usize,
    include_dirs: bool,
    include_hidden: bool,
    log_context: Option<LogContext>,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log_with_context(
        "glob_files",
        "start",
        json!({
            "cwd": cwd,
            "patternCount": patterns.len(),
            "maxMatches": max_matches,
            "includeDirs": include_dirs,
            "includeHidden": include_hidden
        }),
        log_context.as_ref(),
    );

    let result: Result<Value, String> = (|| {
        let base = PathBuf::from(&cwd);
        let mut matches: Vec<String> = Vec::new();
        let mut truncated = false;

        // Separate positive and negative (exclusion) patterns
        let pos_patterns: Vec<glob::Pattern> = patterns
            .iter()
            .filter(|p| !p.starts_with('!'))
            .filter_map(|p| glob::Pattern::new(p).ok())
            .collect();
        let neg_patterns: Vec<glob::Pattern> = patterns
            .iter()
            .filter(|p| p.starts_with('!'))
            .filter_map(|p| glob::Pattern::new(&p[1..]).ok())
            .collect();

        // Walk the directory tree respecting .gitignore
        let walker = ignore::WalkBuilder::new(&base)
            .hidden(!include_hidden)
            .filter_entry(move |e| {
                // Always include .github even when hidden files are excluded
                if !include_hidden {
                    let name = e.file_name().to_string_lossy();
                    if name == ".github" {
                        return true;
                    }
                }
                true
            })
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .build();

        let match_opts = glob::MatchOptions {
            case_sensitive: true,
            require_literal_separator: false,
            require_literal_leading_dot: false,
        };

        'walk: for result in walker {
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };

            let is_dir = entry.file_type().map_or(false, |ft| ft.is_dir());
            if is_dir && !include_dirs {
                continue;
            }

            let rel = match entry.path().strip_prefix(&base) {
                Ok(r) => r.to_string_lossy().to_string(),
                Err(_) => continue,
            };

            // Must match at least one positive pattern
            if !pos_patterns.is_empty()
                && !pos_patterns
                    .iter()
                    .any(|p| p.matches_with(&rel, match_opts))
            {
                continue;
            }

            // Must not match any negative pattern
            if neg_patterns
                .iter()
                .any(|p| p.matches_with(&rel, match_opts))
            {
                continue;
            }

            if matches.len() >= max_matches {
                truncated = true;
                break 'walk;
            }
            matches.push(rel);
        }

        matches.sort();
        Ok(json!({ "matches": matches, "truncated": truncated }))
    })();

    match &result {
        Ok(v) => tool_log_with_context(
            "glob_files",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "matchCount": v["matches"].as_array().map(|a| a.len()).unwrap_or(0),
                "truncated": v["truncated"]
            }),
            log_context.as_ref(),
        ),
        Err(e) => tool_log_with_context(
            "glob_files",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn search_files(cwd: String, max_results: usize) -> Result<Value, String> {
    let start = Instant::now();
    tool_log(
        "search_files",
        "start",
        json!({ "cwd": cwd, "maxResults": max_results }),
    );

    let result: Result<Value, String> = (|| {
        let mut matches = Vec::new();
        let mut truncated = false;

        let walker = ignore::WalkBuilder::new(&cwd).hidden(false).build();

        let cwd_path = PathBuf::from(&cwd);

        for result in walker {
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };

            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                continue;
            }

            if let Ok(rel_path) = entry.path().strip_prefix(&cwd_path) {
                if rel_path.components().any(|c| c.as_os_str() == ".git") {
                    continue;
                }
                matches.push(rel_path.to_string_lossy().to_string());
            }

            if matches.len() >= max_results {
                truncated = true;
                break;
            }
        }

        Ok(json!({ "matches": matches, "truncated": truncated }))
    })();

    match &result {
        Ok(v) => tool_log(
            "search_files",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "matchCount": v["matches"].as_array().map(|a| a.len()).unwrap_or(0),
                "truncated": v["truncated"]
            }),
        ),
        Err(e) => tool_log(
            "search_files",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
        ),
    }

    result
}

#[tauri::command]
pub fn search_files_grep(
    pattern: String,
    root_dir: String,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    max_matches: usize,
    case_sensitive: bool,
    include_hidden: bool,
    context_lines: usize,
    follow_symlinks: bool,
    log_context: Option<LogContext>,
) -> Result<Value, String> {
    let start = Instant::now();
    tool_log_with_context(
        "search_files_grep",
        "start",
        json!({
            "rootDir": root_dir,
            "patternBytes": pattern.as_bytes().len(),
            "includeGlobCount": include_globs.len(),
            "excludeGlobCount": exclude_globs.len(),
            "maxMatches": max_matches,
            "caseSensitive": case_sensitive,
            "includeHidden": include_hidden,
            "contextLines": context_lines,
            "followSymlinks": follow_symlinks
        }),
        log_context.as_ref(),
    );

    let result: Result<Value, String> = (|| {
        use grep::regex::RegexMatcherBuilder;
        use grep::searcher::{
            BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkContextKind,
            SinkMatch,
        };

        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(!case_sensitive)
            .build(&pattern)
            .map_err(|e| format!("Invalid pattern: {}", e))?;

        let mut walker_builder = ignore::WalkBuilder::new(&root_dir);
        walker_builder
            .hidden(!include_hidden)
            .filter_entry(move |e| {
                // Always include .github even when hidden files are excluded
                if !include_hidden {
                    let name = e.file_name().to_string_lossy();
                    if name == ".github" {
                        return true;
                    }
                }
                true
            })
            .follow_links(follow_symlinks)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true);

        if !include_globs.is_empty() || !exclude_globs.is_empty() {
            let mut overrides = ignore::overrides::OverrideBuilder::new(&root_dir);
            for glob in &include_globs {
                overrides
                    .add(glob)
                    .map_err(|e| format!("Bad include glob '{}': {}", glob, e))?;
            }
            for glob in &exclude_globs {
                overrides
                    .add(&format!("!{}", glob))
                    .map_err(|e| format!("Bad exclude glob '{}': {}", glob, e))?;
            }
            let built = overrides
                .build()
                .map_err(|e| format!("Glob override error: {}", e))?;
            walker_builder.overrides(built);
        }

        let root_path = PathBuf::from(&root_dir);

        let mut results: Vec<Value> = Vec::new();
        let mut total_match_count = 0usize;
        let mut searched_files = 0usize;
        let mut truncated = false;

        struct MatchEntry {
            line_number: usize,
            line: String,
            context_before: Vec<String>,
            context_after: Vec<String>,
        }

        struct CollectSink {
            before_buf: Vec<String>,
            entries: Vec<MatchEntry>,
        }

        impl Sink for CollectSink {
            type Error = std::io::Error;

            fn matched(
                &mut self,
                _searcher: &Searcher,
                mat: &SinkMatch<'_>,
            ) -> Result<bool, Self::Error> {
                let line_num = mat.line_number().unwrap_or(0) as usize;
                let line_text = String::from_utf8_lossy(mat.bytes())
                    .trim_end_matches('\n')
                    .to_string();
                self.entries.push(MatchEntry {
                    line_number: line_num,
                    line: line_text,
                    context_before: std::mem::take(&mut self.before_buf),
                    context_after: Vec::new(),
                });
                Ok(true)
            }

            fn context(
                &mut self,
                _searcher: &Searcher,
                ctx: &SinkContext<'_>,
            ) -> Result<bool, Self::Error> {
                let line_text = String::from_utf8_lossy(ctx.bytes())
                    .trim_end_matches('\n')
                    .to_string();
                match ctx.kind() {
                    SinkContextKind::Before => self.before_buf.push(line_text),
                    SinkContextKind::After => {
                        if let Some(last) = self.entries.last_mut() {
                            last.context_after.push(line_text);
                        }
                    }
                    _ => {}
                }
                Ok(true)
            }
        }

        'walk: for entry in walker_builder.build() {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let ft = match entry.file_type() {
                Some(ft) => ft,
                None => continue,
            };
            if !ft.is_file() {
                continue;
            }

            searched_files += 1;

            let rel_path = entry
                .path()
                .strip_prefix(&root_path)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .to_string();

            let file_content = match fs::read(entry.path()) {
                Ok(b) => b,
                Err(_) => continue,
            };
            // Binary detection: if there's a NUL byte in the first 8 KiB, skip
            let probe = &file_content[..file_content.len().min(8192)];
            if probe.contains(&0u8) {
                continue;
            }
            let text = match std::str::from_utf8(&file_content) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .before_context(context_lines)
                .after_context(context_lines)
                .build();

            let mut sink = CollectSink {
                before_buf: Vec::new(),
                entries: Vec::new(),
            };

            let _ = searcher.search_slice(&matcher, text.as_bytes(), &mut sink);

            for hit in sink.entries {
                if total_match_count >= max_matches {
                    truncated = true;
                    break 'walk;
                }
                results.push(json!({
                    "path": rel_path,
                    "lineNumber": hit.line_number,
                    "line": hit.line,
                    "contextBefore": hit.context_before,
                    "contextAfter": hit.context_after,
                }));
                total_match_count += 1;
            }
        }

        Ok(json!({
            "matches": results,
            "truncated": truncated,
            "searchedFiles": searched_files,
            "matchCount": total_match_count,
        }))
    })();

    match &result {
        Ok(v) => tool_log_with_context(
            "search_files_grep",
            "ok",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "matchCount": v["matchCount"],
                "searchedFiles": v["searchedFiles"],
                "truncated": v["truncated"]
            }),
            log_context.as_ref(),
        ),
        Err(e) => tool_log_with_context(
            "search_files_grep",
            "err",
            json!({
                "durationMs": start.elapsed().as_millis() as u64,
                "error": e
            }),
            log_context.as_ref(),
        ),
    }

    result
}

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    let encoded = BASE64.encode(&bytes);
    // Derive a best-effort MIME type from the extension.
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    Ok(json!({
        "data": encoded,
        "mimeType": mime,
        "sizeBytes": bytes.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_write_and_read_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        let path_str = file_path.to_string_lossy().to_string();

        // 1. Test writing a new file
        let write_res = write_file(
            path_str.clone(),
            "hello world\nline2".to_string(),
            "create".to_string(),
            false,
            None,
        )
        .unwrap();
        assert_eq!(write_res["created"], true);
        assert_eq!(write_res["overwritten"], false);
        assert_eq!(write_res["bytesWritten"], 17);

        // 2. Test writing over existing with "create" mode should fail
        let fail_res = write_file(
            path_str.clone(),
            "fail".to_string(),
            "create".to_string(),
            false,
            None,
        );
        assert!(fail_res.is_err());

        // 3. Test reading the entire file
        let read_res = read_file(path_str.clone(), None, None, 1000, None).unwrap();
        assert_eq!(read_res["content"], "hello world\nline2");
        assert_eq!(read_res["truncated"], false);

        // 4. Test reading with line ranges
        let read_line_res = read_file(path_str.clone(), Some(1), Some(1), 1000, None).unwrap();
        assert_eq!(read_line_res["content"], "hello world");
        assert_eq!(read_line_res["lineCount"], 2);

        // 5. Test reading a missing file should error
        let missing_path = dir.path().join("does_not_exist.txt");
        let missing_res = read_file(
            missing_path.to_string_lossy().to_string(),
            None,
            None,
            1000,
            None,
        );
        assert!(missing_res.is_err());
    }

    #[test]
    fn test_list_dir() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, "test_content").unwrap();
        let hidden_file = dir.path().join(".hidden");
        fs::write(&hidden_file, "hidden_content").unwrap();

        let path_str = dir.path().to_string_lossy().to_string();

        // 1. Without hidden files
        let res1 = list_dir(path_str.clone(), false, 100, None).unwrap();
        let entries = res1["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "test.txt");

        // 2. With hidden files
        let res2 = list_dir(path_str.clone(), true, 100, None).unwrap();
        let entries2 = res2["entries"].as_array().unwrap();
        assert_eq!(entries2.len(), 2);

        // 3. .github dir is always visible even without include_hidden
        let github_dir = dir.path().join(".github");
        fs::create_dir(&github_dir).unwrap();
        fs::write(github_dir.join("CODEOWNERS"), "* @owner").unwrap();
        let res3 = list_dir(path_str.clone(), false, 100, None).unwrap();
        let entries3 = res3["entries"].as_array().unwrap();
        let names3: Vec<&str> = entries3.iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert!(names3.contains(&".github"), ".github should be visible without includeHidden");
        assert!(!names3.contains(&".hidden"), ".hidden should still be excluded");
    }

    #[test]
    fn test_glob_files() {
        let dir = tempdir().unwrap();
        let path_str = dir.path().to_string_lossy().to_string();

        fs::write(dir.path().join("main.rs"), "fn main() {}").unwrap();
        fs::write(dir.path().join("lib.rs"), "pub mod lib;").unwrap();
        fs::write(dir.path().join("README.md"), "# readme").unwrap();
        fs::write(dir.path().join("notes.md"), "notes").unwrap();
        fs::create_dir(dir.path().join("dist")).unwrap();
        fs::write(dir.path().join("dist").join("bundle.js"), "bundle").unwrap();

        // Write a .ignore file that excludes *.md and the dist/ directory.
        fs::write(dir.path().join(".ignore"), "*.md\ndist/\n").unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
        fs::create_dir(dir.path().join(".cache")).unwrap();
        fs::write(dir.path().join(".cache").join("nested.txt"), "cached").unwrap();

        // 1. Match all .rs files — should find both .rs files
        let res = glob_files(
            vec!["*.rs".to_string()],
            path_str.clone(),
            100,
            false,
            false,
            None,
        )
        .unwrap();
        let matches: Vec<&str> = res["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(matches.contains(&"main.rs"), "Should find main.rs");
        assert!(matches.contains(&"lib.rs"), "Should find lib.rs");
        assert!(
            !matches.contains(&"README.md"),
            "*.md should be excluded by .gitignore"
        );
        assert!(
            !matches.iter().any(|p| p.starts_with("dist")),
            "dist/ should be excluded by .gitignore"
        );

        // 2. Match all files with include_hidden=false — hidden + ignored ones must be absent
        let res_all = glob_files(
            vec!["**/*".to_string()],
            path_str.clone(),
            100,
            false,
            false,
            None,
        )
        .unwrap();
        let all_matches: Vec<&str> = res_all["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(!all_matches.contains(&"README.md"), "README.md gitignored");
        assert!(!all_matches.contains(&"notes.md"), "notes.md gitignored");
        assert!(
            !all_matches.iter().any(|p| p.starts_with("dist")),
            "dist/ gitignored"
        );
        assert!(
            !all_matches.contains(&".env"),
            "hidden files are excluded by default"
        );
        assert!(
            !all_matches.iter().any(|p| p.starts_with(".cache")),
            "hidden directories are excluded by default"
        );

        // 3. Negative pattern exclusion on top of gitignore
        let res_neg = glob_files(
            vec!["*.rs".to_string(), "!lib.rs".to_string()],
            path_str.clone(),
            100,
            false,
            false,
            None,
        )
        .unwrap();
        let neg_matches: Vec<&str> = res_neg["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(neg_matches.contains(&"main.rs"));
        assert!(
            !neg_matches.contains(&"lib.rs"),
            "lib.rs excluded by !lib.rs"
        );

        // 4. include_hidden enables hidden file/dir matches
        let res_hidden = glob_files(
            vec!["**/*".to_string()],
            path_str.clone(),
            100,
            false,
            true,
            None,
        )
        .unwrap();
        let hidden_matches: Vec<&str> = res_hidden["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(
            hidden_matches.contains(&".env"),
            "hidden file should be included"
        );
        assert!(
            hidden_matches.iter().any(|p| p.starts_with(".cache")),
            "hidden directory contents should be included"
        );

        // 5. max_matches truncation
        let res_trunc = glob_files(
            vec!["*.rs".to_string()],
            path_str.clone(),
            1,
            false,
            false,
            None,
        )
        .unwrap();
        assert_eq!(res_trunc["truncated"], true);
        assert_eq!(res_trunc["matches"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_search_files_and_grep() {
        let dir = tempdir().unwrap();
        let path_str = dir.path().to_string_lossy().to_string();

        let file1 = dir.path().join("file1.txt");
        fs::write(&file1, "hello world\nthis is a test\n").unwrap();

        let file2 = dir.path().join("file2.md");
        fs::write(&file2, "rust is great\ntest line\n").unwrap();

        let ignore_file = dir.path().join(".ignore");
        fs::write(&ignore_file, "*.md\n").unwrap();

        // 1. Basic search_files
        let search_res = search_files(path_str.clone(), 10).unwrap();
        let matches = search_res["matches"].as_array().unwrap();
        let paths: Vec<&str> = matches.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(paths.contains(&"file1.txt"), "Should find file1.txt");
        assert!(
            !paths.contains(&"file2.md"),
            "Should ignore file2.md due to .ignore"
        );

        // 2. Grep search
        let grep_res = search_files_grep(
            "test".to_string(),
            path_str.clone(),
            vec![],
            vec![],
            10,
            false,
            false,
            0,
            false,
            None,
        )
        .unwrap();
        let grep_matches = grep_res["matches"].as_array().unwrap();
        assert_eq!(
            grep_res["matchCount"], 1,
            "Should only find one match because .md is ignored"
        );
        assert_eq!(grep_matches[0]["line"], "this is a test");
    }
}
