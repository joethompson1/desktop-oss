// Skill-file discovery and live filesystem watching for the slash-menu.
//
// Two responsibilities:
//
//   1. `list_skill_files(roots)` — given a list of directories, scan
//      each one shallowly for both flat-file skills (`commands/foo.md`,
//      `prompts/foo.md`) and nested-directory skills (`skills/foo/SKILL.md`).
//      Returns provenance metadata; the TS side reads each file with
//      the existing `read_text_file` command.
//
//   2. `watch_skill_dirs(roots, channel)` — install a debounced
//      filesystem watcher (300ms emit debounce, mirrors Claude Code's
//      chokidar config) on each root. Emits `SkillFsEvent::Changed`
//      for any path-touching event; the TS side re-runs the relevant
//      loader and refreshes the registry.
//
// Distinguishing added/changed/removed from notify-debouncer-mini
// events isn't reliable — paths can disappear between event emission
// and the re-scan. Always emit "changed" and let the TS-side re-scan
// be the source of truth.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

#[derive(Debug, Serialize, Clone)]
pub struct SkillFileEntry {
    /// Absolute path to the markdown file we believe is a skill.
    pub path: String,
    /// Shape of the entry — drives how the TS loader derives the
    /// skill name (basename for "flat", parent-dir name for "nested").
    pub kind: SkillFileKind,
    /// File mtime in milliseconds since epoch — used by the TS side
    /// to dedupe rapid re-emit events.
    pub mtime_ms: i64,
    /// File size in bytes — informational; the TS side reads via
    /// `read_text_file` regardless.
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SkillFileKind {
    /// `<root>/<name>.md` — Codex prompts, Cursor commands, legacy
    /// Claude commands.
    Flat,
    /// `<root>/<name>/SKILL.md` — Claude skills, Cursor skills-cursor,
    /// Local skills.
    Nested,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SkillFsEvent {
    Changed { path: String },
}

/// One-shot scan of each root directory. Roots that don't exist are
/// silently skipped — sources the user hasn't installed (e.g. Codex)
/// shouldn't blow up discovery.
#[tauri::command]
pub fn list_skill_files(roots: Vec<String>) -> Vec<SkillFileEntry> {
    let mut entries = Vec::new();
    for root in roots {
        scan_root(Path::new(&root), &mut entries);
    }
    entries
}

fn scan_root(root: &Path, out: &mut Vec<SkillFileEntry>) {
    let read_dir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.is_file() {
            if path.extension().and_then(|s| s.to_str()) == Some("md") {
                push_entry(&path, SkillFileKind::Flat, out);
            }
        } else if metadata.is_dir() {
            let skill_md = path.join("SKILL.md");
            if let Ok(m) = std::fs::metadata(&skill_md) {
                if m.is_file() {
                    push_entry(&skill_md, SkillFileKind::Nested, out);
                }
            }
        }
    }
}

fn push_entry(path: &Path, kind: SkillFileKind, out: &mut Vec<SkillFileEntry>) {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    out.push(SkillFileEntry {
        path: path.to_string_lossy().into_owned(),
        kind,
        mtime_ms,
        size_bytes: metadata.len(),
    });
}

/// Output of a single shell expansion. Stdout / stderr are captured
/// separately so the TS side can format them (Bash convention:
/// stderr inline with a `(stderr)` marker, matching Claude Code's
/// `formatBashOutput`).
#[derive(Debug, Serialize, Clone)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// True when the command exceeded `timeout_ms` and was killed.
    pub timed_out: bool,
}

const STDOUT_CAP: usize = 1 * 1024 * 1024; // 1 MiB
const STDERR_CAP: usize = 256 * 1024; // 256 KiB

/// Run a `!\`cmd\`` block from a skill body. Bash on Unix; PowerShell
/// support is a stub — falls through to bash when `pwsh` isn't on
/// PATH. Output is captured with hard caps to prevent a runaway
/// command flooding the model's context.
///
/// Permission gating happens on the TS side BEFORE this is called;
/// reaching this command means the user already approved the
/// pattern.
#[tauri::command]
pub async fn run_skill_shell(
    cmd: String,
    shell: String,
    cwd: String,
    timeout_ms: u64,
) -> Result<ShellResult, String> {
    let (program, flag) = match shell.as_str() {
        "powershell" | "pwsh" => match which_pwsh() {
            Some(p) => (p, "-Command"),
            None => ("/bin/bash".to_string(), "-c"),
        },
        _ => ("/bin/bash".to_string(), "-c"),
    };
    let mut command = TokioCommand::new(&program);
    command
        .arg(flag)
        .arg(&cmd)
        .current_dir(&cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let stdout = child.stdout.take().ok_or("missing stdout pipe")?;
    let stderr = child.stderr.take().ok_or("missing stderr pipe")?;
    let stdout_task =
        tokio::spawn(async move { read_capped(stdout, STDOUT_CAP).await });
    let stderr_task =
        tokio::spawn(async move { read_capped(stderr, STDERR_CAP).await });
    let wait_fut = child.wait();
    let result = timeout(Duration::from_millis(timeout_ms), wait_fut).await;
    let (status, timed_out) = match result {
        Ok(Ok(s)) => (s, false),
        Ok(Err(e)) => return Err(format!("wait failed: {e}")),
        Err(_) => {
            // Timed out — kill the child. The wait future has been
            // dropped so we use a fresh handle.
            let _ = child.start_kill();
            (
                child.wait().await.map_err(|e| format!("wait after kill: {e}"))?,
                true,
            )
        }
    };
    let stdout_str = stdout_task
        .await
        .map_err(|e| format!("stdout task: {e}"))?;
    let stderr_str = stderr_task
        .await
        .map_err(|e| format!("stderr task: {e}"))?;
    Ok(ShellResult {
        stdout: stdout_str,
        stderr: stderr_str,
        exit_code: status.code().unwrap_or(-1),
        timed_out,
    })
}

async fn read_capped<R: AsyncReadExt + Unpin>(mut reader: R, cap: usize) -> String {
    let mut buf = Vec::with_capacity(cap.min(64 * 1024));
    let mut chunk = [0u8; 8192];
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let remaining = cap.saturating_sub(buf.len());
        if remaining == 0 {
            break;
        }
        let take = n.min(remaining);
        buf.extend_from_slice(&chunk[..take]);
        if take < n {
            break; // hit cap mid-chunk
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn which_pwsh() -> Option<String> {
    use std::process::Command;
    let output = Command::new("/usr/bin/which").arg("pwsh").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Install a recursive watcher per root. The watcher emits one event
/// per path that changed, debounced 300ms. The TS side reacts by
/// re-running discovery — we don't try to be clever about classifying
/// added/changed/removed because paths can disappear in the time
/// between event and handling.
#[tauri::command]
pub fn watch_skill_dirs(
    roots: Vec<String>,
    channel: Channel<SkillFsEvent>,
) -> Result<(), String> {
    std::thread::spawn(move || {
        let result = new_debouncer(
            Duration::from_millis(300),
            move |result: DebounceEventResult| {
                if let Ok(events) = result {
                    for ev in events {
                        let path = ev.path.to_string_lossy().into_owned();
                        let _ = channel.send(SkillFsEvent::Changed { path });
                    }
                }
            },
        );
        let mut debouncer = match result {
            Ok(d) => d,
            Err(e) => {
                eprintln!("watch_skill_dirs: debouncer init failed: {e}");
                return;
            }
        };
        for root in &roots {
            let p = PathBuf::from(root);
            if p.exists() {
                if let Err(e) = debouncer.watcher().watch(&p, RecursiveMode::Recursive) {
                    eprintln!("watch_skill_dirs: watch({root}) failed: {e}");
                }
            }
        }
        // The debouncer's worker thread runs internally; we just need
        // to keep this thread alive so `debouncer` doesn't drop.
        std::thread::park();
    });
    Ok(())
}
