// PTY + file-tail plumbing for TUI-mode delegates (dual-surface delegates).
//
// Generic infrastructure, deliberately feature-agnostic: `pty_*` runs any
// command in a pseudo-terminal and streams raw bytes over a Tauri Channel
// (the webview renders them with xterm.js); `tail_file` streams a file's
// appended bytes (the webview uses it for Claude Code's transcript JSONL
// and the hook relay file). A future ad-hoc terminal module can reuse the
// PTY surface unchanged.
//
// Bytes cross the Channel base64-encoded: Channel payloads are JSON, and
// lossy utf-8 conversion could corrupt a multibyte character split across
// two reads. The TS side decodes and feeds a streaming TextDecoder (tail)
// or xterm (PTY), both of which handle split codepoints correctly.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Monotonic spawn generation. A respawn REPLACES the registry entry
    /// (see pty_spawn); the old child's waiter thread must only remove
    /// the entry if it still belongs to ITS generation, or it would
    /// delete the replacement's registration.
    generation: u64,
}

fn next_generation() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn pty_sessions() -> &'static Mutex<HashMap<String, PtySession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, PtySession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tail_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Events the JS side receives from `pty_spawn` over a Tauri Channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum PtyEvent {
    /// PTY child started.
    Spawned { pid: u32 },
    /// Raw output bytes (base64). Feed to xterm.write after decoding.
    Data { data: String },
    /// Child exited. `code` is None when killed by a signal.
    Exit { code: Option<u32> },
}

/// Events the JS side receives from `tail_file` over a Tauri Channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum TailEvent {
    /// Newly appended bytes (base64) and the file offset AFTER them.
    Data { data: String, offset: u64 },
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Same PATH augmentation as `with_login_path` in lib.rs — GUI apps on
/// macOS don't inherit the login shell's PATH, so homebrew/node shims
/// would be invisible to the PTY child without this.
fn login_path() -> String {
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{extra}:{p}"),
        _ => extra.to_string(),
    }
}

/// Spawn `command args...` in a fresh PTY and stream its output over
/// `on_event`. `session_id` names the PTY for later `pty_write` /
/// `pty_resize` / `pty_kill` calls; spawning over an existing id fails.
#[tauri::command]
pub fn pty_spawn(
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    // Replace semantics: spawning over a live id kills the previous child
    // and takes its slot. This is load-bearing for dev HMR — a hot module
    // swap wipes the webview's session registry while the Rust-side PTY
    // lives on; the re-attach must be able to reclaim the id instead of
    // erroring. The orphan's waiter thread skips cleanup via `generation`.
    {
        let mut sessions = pty_sessions().lock().map_err(|e| e.to_string())?;
        if let Some(previous) = sessions.get_mut(&session_id) {
            eprintln!("[pty:{session_id}] replacing live session (gen {})", previous.generation);
            let _ = previous.killer.kill();
            sessions.remove(&session_id);
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    cmd.env("PATH", login_path());
    cmd.env("TERM", "xterm-256color");
    // Mark the session so hooks/tooling inside can tell it's embedded.
    cmd.env("DESKTOP_OSS_TUI", "1");
    if let Some(dir) = &cwd {
        cmd.cwd(dir);
    }
    if let Some(extra) = env {
        for (k, v) in extra {
            cmd.env(k, v);
        }
    }

    eprintln!("[pty:{session_id}] spawning: {command} {args:?} (cwd={cwd:?})");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        let msg = format!("pty spawn failed for '{command}': {e}");
        eprintln!("[pty:{session_id}] {msg}");
        msg
    })?;
    // Close our copy of the slave so the reader sees EOF when the child
    // exits instead of blocking forever.
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;

    let pid = child.process_id().unwrap_or(0);
    let _ = on_event.send(PtyEvent::Spawned { pid });

    let generation = next_generation();
    {
        let mut sessions = pty_sessions().lock().map_err(|e| e.to_string())?;
        sessions.insert(
            session_id.clone(),
            PtySession {
                master: pair.master,
                writer,
                killer,
                generation,
            },
        );
    }

    // Blocking reader thread: PTY reads have no async story worth the
    // complexity — a dedicated thread per live terminal is fine at this
    // app's scale (one or two TUI delegates at a time).
    let reader_channel = on_event.clone();
    let reader_session = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if reader_channel
                        .send(PtyEvent::Data { data: b64(&buf[..n]) })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        eprintln!("[pty:{reader_session}] reader ended");
    });

    // Waiter thread: report exit and clean the registry entry so the id
    // becomes reusable and the master/writer handles drop.
    let exit_channel = on_event;
    let exit_session = session_id;
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        if let Ok(mut sessions) = pty_sessions().lock() {
            // Only clean up OUR registration — if a respawn replaced this
            // entry, the map now belongs to the new generation.
            if sessions
                .get(&exit_session)
                .is_some_and(|s| s.generation == generation)
            {
                sessions.remove(&exit_session);
            }
        }
        eprintln!("[pty:{exit_session}] exited code={code:?} (gen {generation})");
        let _ = exit_channel.send(PtyEvent::Exit { code });
    });

    Ok(())
}

/// Write user input (base64 bytes) to a live PTY session's stdin.
#[tauri::command]
pub fn pty_write(session_id: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| format!("bad base64: {e}"))?;
    let mut sessions = pty_sessions().lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("no pty session '{session_id}'"))?;
    session
        .writer
        .write_all(&bytes)
        .and_then(|_| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
}

/// Resize a live PTY (xterm fit-addon drives this on container resize).
#[tauri::command]
pub fn pty_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = pty_sessions().lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no pty session '{session_id}'"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

/// Kill a PTY session's child. The waiter thread then reports Exit and
/// removes the registry entry. Killing an unknown id is a no-op success —
/// callers race the child's natural exit.
#[tauri::command]
pub fn pty_kill(session_id: String) -> Result<(), String> {
    let mut sessions = pty_sessions().lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&session_id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

/// Whether a PTY session with this id is currently live. The run page uses
/// this to re-attach its terminal view after a route change without
/// spawning a duplicate.
#[tauri::command]
pub fn pty_alive(session_id: String) -> Result<bool, String> {
    let sessions = pty_sessions().lock().map_err(|e| e.to_string())?;
    Ok(sessions.contains_key(&session_id))
}

/// Stream a file's appended bytes over `on_event`, polling ~4×/second.
///
/// `from_offset < 0` means "start at the current end of file" — used for
/// transcript mirroring where history before attach must be skipped (it
/// was persisted by another driver). A missing file is not an error: the
/// tail waits for it to appear (relay files / transcripts are created by
/// the CLI after we start watching). If the file shrinks (rotation), the
/// offset resets to 0.
///
/// Runs until `tail_stop(watch_id)`. Starting a second tail with the same
/// watch_id stops the first.
#[tauri::command]
pub fn tail_file(
    watch_id: String,
    path: String,
    from_offset: i64,
    on_event: Channel<TailEvent>,
) -> Result<(), String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut flags = tail_flags().lock().map_err(|e| e.to_string())?;
        if let Some(prev) = flags.insert(watch_id.clone(), cancelled.clone()) {
            prev.store(true, Ordering::Relaxed);
        }
    }

    std::thread::spawn(move || {
        let mut offset: Option<u64> = if from_offset >= 0 {
            Some(from_offset as u64)
        } else {
            None // resolve to EOF on first sighting of the file
        };
        loop {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let len = meta.len();
            let current = match offset {
                None => {
                    offset = Some(len);
                    continue;
                }
                Some(o) if o > len => {
                    // Truncated/rotated — start over from the top.
                    offset = Some(0);
                    0
                }
                Some(o) => o,
            };
            if len == current {
                continue;
            }
            let Ok(mut file) = std::fs::File::open(&path) else {
                continue;
            };
            if file.seek(SeekFrom::Start(current)).is_err() {
                continue;
            }
            // Cap one iteration's read so a huge backlog can't build a
            // single giant Channel message; the loop drains the rest.
            let to_read = (len - current).min(1_000_000) as usize;
            let mut buf = vec![0u8; to_read];
            let Ok(()) = file.read_exact(&mut buf) else {
                continue;
            };
            let new_offset = current + to_read as u64;
            offset = Some(new_offset);
            if on_event
                .send(TailEvent::Data {
                    data: b64(&buf),
                    offset: new_offset,
                })
                .is_err()
            {
                break;
            }
        }
        eprintln!("[tail:{watch_id}] stopped");
        if let Ok(mut flags) = tail_flags().lock() {
            if let Some(current) = flags.get(&watch_id) {
                if current.load(Ordering::Relaxed) {
                    flags.remove(&watch_id);
                }
            }
        }
    });

    Ok(())
}

/// Size of a file in bytes, or null when it doesn't exist. The TUI
/// driver uses this on the (deterministic) transcript path to decide
/// fresh-vs-resume: `claude --resume` refuses a session with no recorded
/// conversation, so "a session id exists" is not evidence enough.
#[tauri::command]
pub fn file_size(path: String) -> Option<u64> {
    std::fs::metadata(&path).ok().map(|m| m.len())
}

/// Stop a running `tail_file` watcher. Unknown ids are a no-op.
#[tauri::command]
pub fn tail_stop(watch_id: String) -> Result<(), String> {
    let flags = tail_flags().lock().map_err(|e| e.to_string())?;
    if let Some(flag) = flags.get(&watch_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
