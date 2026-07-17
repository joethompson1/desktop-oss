use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use tauri::ipc::Channel;
use thiserror::Error;
use tauri_plugin_sql::{Migration, MigrationKind};

mod skills;
use skills::{list_skill_files, run_skill_shell, watch_skill_dirs};
mod tui;
use tui::{file_size, pty_alive, pty_kill, pty_resize, pty_spawn, pty_write, tail_file, tail_stop};

const MAX_ATTACHMENT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
enum FsError {
    #[error("file too large: {0} bytes (limit {1})")]
    TooLarge(u64, u64),
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("read failed: {0}")]
    ReadFailed(String),
}

#[derive(Debug, Serialize)]
struct AttachmentPayload {
    data_base64: String,
    size_bytes: u64,
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<AttachmentPayload, FsError> {
    let metadata = std::fs::metadata(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound(path.clone()),
        _ => FsError::ReadFailed(e.to_string()),
    })?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_ATTACHMENT_BYTES {
        return Err(FsError::TooLarge(size_bytes, MAX_ATTACHMENT_BYTES));
    }
    let bytes = std::fs::read(&path).map_err(|e| FsError::ReadFailed(e.to_string()))?;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(AttachmentPayload {
        data_base64,
        size_bytes,
    })
}

/// Read a file as UTF-8 text. Used by the orchestrator's `read_file` tool
/// and by the Claude Code credentials reader.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, FsError> {
    std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound(path.clone()),
        _ => FsError::ReadFailed(e.to_string()),
    })
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), FsError> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| FsError::ReadFailed(e.to_string()))?;
    }
    std::fs::write(&path, contents).map_err(|e| FsError::ReadFailed(e.to_string()))
}

#[derive(Debug, Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size_bytes: u64,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, FsError> {
    let read_dir = std::fs::read_dir(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => FsError::NotFound(path.clone()),
        _ => FsError::ReadFailed(e.to_string()),
    })?;
    let mut entries = Vec::new();
    for entry in read_dir.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path().to_string_lossy().into_owned();
        entries.push(DirEntry {
            name,
            path,
            is_dir: metadata.is_dir(),
            size_bytes: metadata.len(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(entries)
}

/// Resolve the absolute path of the user's home directory.
/// Used by the frontend to locate `~/.claude/`.
#[tauri::command]
fn home_dir() -> Option<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
struct PrInfo {
    state: String,
    number: u64,
    url: String,
    additions: Option<i64>,
    deletions: Option<i64>,
    is_draft: bool,
}

#[derive(Debug, Serialize)]
struct RepoStatus {
    is_repo: bool,
    repository: Option<String>,
    branch: Option<String>,
    base_branch: Option<String>,
    dirty: bool,
    ahead: Option<i64>,
    behind: Option<i64>,
    pr: Option<PrInfo>,
    gh_available: bool,
    error: Option<String>,
}

/// Augment a child process's PATH with the common Homebrew / system bin
/// dirs. A Finder-launched `.app` inherits a minimal PATH and otherwise
/// can't find `git` / `gh` (installed under /opt/homebrew/bin etc.).
fn with_login_path(cmd: &mut std::process::Command) {
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    let path = match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{extra}:{p}"),
        _ => extra.to_string(),
    };
    cmd.env("PATH", path);
}

/// Run `program args…` in `dir`. Returns (success, stdout, stderr), or None
/// if the program could not be spawned (not installed).
fn run_in(dir: &str, program: &str, args: &[&str]) -> Option<(bool, String, String)> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).current_dir(dir);
    with_login_path(&mut cmd);
    cmd.output().ok().map(|out| {
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    })
}

/// True when a `git` binary can be spawned. Consulted once by the git
/// module's default-enablement probe.
#[tauri::command]
fn git_available() -> bool {
    run_in(".", "git", &["--version"])
        .map(|(ok, _, _)| ok)
        .unwrap_or(false)
}

/// Compute the git + GitHub status of a working directory by shelling out
/// to `git` and `gh`. Local-first equivalent of a webhook-driven PR
/// state. Always returns a value; failures are represented in the fields
/// (`is_repo`, `gh_available`, `error`) rather than thrown.
#[tauri::command]
fn repo_status(path: String) -> RepoStatus {
    let mut status = RepoStatus {
        is_repo: false,
        repository: None,
        branch: None,
        base_branch: None,
        dirty: false,
        ahead: None,
        behind: None,
        pr: None,
        gh_available: true,
        error: None,
    };

    match run_in(&path, "git", &["rev-parse", "--is-inside-work-tree"]) {
        Some((true, out, _)) if out.trim() == "true" => status.is_repo = true,
        Some(_) => return status,
        None => {
            status.error = Some("git not found".into());
            return status;
        }
    }

    if let Some((true, out, _)) = run_in(&path, "git", &["rev-parse", "--abbrev-ref", "HEAD"]) {
        let b = out.trim().to_string();
        if !b.is_empty() {
            status.branch = Some(b);
        }
    }
    if let Some((true, out, _)) = run_in(&path, "git", &["remote", "get-url", "origin"]) {
        let r = out.trim().to_string();
        if !r.is_empty() {
            status.repository = Some(r);
        }
    }
    if let Some((true, out, _)) = run_in(&path, "git", &["status", "--porcelain"]) {
        status.dirty = !out.trim().is_empty();
    }
    if let Some((true, out, _)) =
        run_in(&path, "git", &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    {
        if let Some(name) = out.trim().strip_prefix("refs/remotes/origin/") {
            if !name.is_empty() {
                status.base_branch = Some(name.to_string());
            }
        }
    }

    // PR for the current branch. Non-zero exit means no PR (or gh missing /
    // unauthed); distinguish via stderr so the UI can still show the branch.
    match run_in(
        &path,
        "gh",
        &[
            "pr",
            "view",
            "--json",
            "state,url,number,additions,deletions,isDraft,baseRefName",
        ],
    ) {
        None => status.gh_available = false,
        Some((true, out, _)) => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
                if let Some(base) = v.get("baseRefName").and_then(|x| x.as_str()) {
                    if !base.is_empty() {
                        status.base_branch = Some(base.to_string());
                    }
                }
                let state = v.get("state").and_then(|x| x.as_str()).unwrap_or("");
                let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
                if !state.is_empty() && !url.is_empty() {
                    status.pr = Some(PrInfo {
                        state: state.to_string(),
                        number: v.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
                        url: url.to_string(),
                        additions: v.get("additions").and_then(|x| x.as_i64()),
                        deletions: v.get("deletions").and_then(|x| x.as_i64()),
                        is_draft: v.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
                    });
                }
            }
        }
        Some((false, _, stderr)) => {
            let e = stderr.to_lowercase();
            if e.contains("auth")
                || e.contains("not logged")
                || e.contains("gh auth login")
            {
                status.gh_available = false;
            }
            // "no pull requests found" / "no git remotes" → no PR; leave pr = None.
        }
    }

    if status.base_branch.is_none() {
        status.base_branch = Some("main".into());
    }

    status
}

/// Subset of Claude Code's stored credentials that we care about.
/// The CLI stores a nested object: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, ... } }`.
#[derive(Debug, Serialize)]
struct ClaudeCodeAccountInfo {
    has_credentials: bool,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<serde_json::Value>,
    email: Option<String>,
}

fn empty_account_info() -> ClaudeCodeAccountInfo {
    ClaudeCodeAccountInfo {
        has_credentials: false,
        access_token: None,
        refresh_token: None,
        expires_at: None,
        email: None,
    }
}

/// Parse the JSON blob that Claude Code stores in its credential vault.
/// Schema (per the @anthropic-ai/claude-agent-sdk source):
/// ```json
/// {
///   "claudeAiOauth": {
///     "accessToken": "...",
///     "refreshToken": "...",
///     "expiresAt": 1234567890000,
///     "scopes": [...],
///     "subscriptionType": "max"
///   }
/// }
/// ```
fn parse_credentials_blob(raw: &str) -> Option<ClaudeCodeAccountInfo> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    // Some installs nest under `claudeAiOauth`; some put fields at the top level.
    // Try both, preferring the nested form.
    let oauth = value
        .get("claudeAiOauth")
        .cloned()
        .unwrap_or_else(|| value.clone());

    let access_token = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        // Logout leaves a stub item with EMPTY-STRING tokens (observed with
        // the native 2.1.x CLI) — treat blank the same as absent so the app
        // reports "not logged in" instead of a phantom account.
        .filter(|t| !t.trim().is_empty())
        .map(String::from);
    if access_token.is_none() {
        return None;
    }

    let refresh_token = oauth
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(String::from);
    let expires_at = oauth.get("expiresAt").cloned();

    // Email lives outside the oauth block in modern versions; fall back to
    // poking around any obvious siblings.
    let email = value
        .get("account")
        .and_then(|a| a.get("email_address").or_else(|| a.get("email")))
        .and_then(|v| v.as_str())
        .or_else(|| value.get("email").and_then(|v| v.as_str()))
        .or_else(|| oauth.get("email").and_then(|v| v.as_str()))
        .map(String::from);

    Some(ClaudeCodeAccountInfo {
        has_credentials: true,
        access_token,
        refresh_token,
        expires_at,
        email,
    })
}

/// macOS: shell out to `/usr/bin/security find-generic-password`. Claude
/// Code stores its OAuth tokens in the login keychain, but the service name
/// has varied across versions — current CLIs use `Claude Code`, older ones
/// (and some SDK builds) use `Claude Code-credentials` — so we try each.
/// Keychain is the authoritative store on darwin; `~/.claude/.credentials.json`
/// is the Linux/WSL fallback.
#[cfg(target_os = "macos")]
fn read_macos_keychain() -> Option<ClaudeCodeAccountInfo> {
    let (_service, raw) = read_macos_keychain_raw()?;
    parse_credentials_blob(&raw)
}

#[cfg(not(target_os = "macos"))]
fn read_macos_keychain() -> Option<ClaudeCodeAccountInfo> {
    None
}

/// Linux / fallback: Claude Code stores its credentials in a flat file
/// `~/.claude/.credentials.json` when keychain isn't available (Linux, WSL).
fn read_credentials_file() -> Option<ClaudeCodeAccountInfo> {
    let (_, raw) = read_credentials_file_raw()?;
    parse_credentials_blob(&raw)
}

/// Read Claude Code OAuth credentials. On macOS this reads the system
/// keychain (the canonical store); elsewhere it falls back to the flat
/// `~/.claude/.credentials.json` file. Returns `has_credentials: false`
/// if no valid login is found — the caller decides whether that's an
/// error or just a "not logged in" state.
#[tauri::command]
fn read_claude_code_credentials() -> ClaudeCodeAccountInfo {
    if let Some(info) = read_macos_keychain() {
        return info;
    }
    if let Some(info) = read_credentials_file() {
        return info;
    }
    empty_account_info()
}

// Claude Code OAuth refresh. Constants pulled from the @anthropic-ai/
// claude-agent-sdk source so the request shape matches what the real CLI
// sends — same endpoint, same client_id, same beta header.
const CC_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CC_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CC_OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(serde::Deserialize)]
struct OAuthRefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

fn current_time_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Exchange a cached `refresh_token` for a fresh `access_token` against
/// Anthropic's OAuth endpoint, then persist the rotated pair back into
/// the same store we read from (macOS keychain, else credentials file).
///
/// Mirrors what the official Claude Code CLI does invisibly when its
/// cached access token expires — without this, the desktop app spuriously
/// tells users to `claude auth login` after a few idle hours.
#[tauri::command]
async fn refresh_claude_code_credentials(
    refresh_token: String,
) -> Result<ClaudeCodeAccountInfo, String> {
    if refresh_token.is_empty() {
        return Err("refresh_token is empty — nothing to refresh".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent(format!("desktop-oss/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("OAuth refresh client build failed: {e}"))?;

    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CC_OAUTH_CLIENT_ID,
    });

    eprintln!("[oauth_refresh] → POST {CC_OAUTH_TOKEN_URL}");
    let res = client
        .post(CC_OAUTH_TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("anthropic-beta", CC_OAUTH_BETA)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OAuth refresh request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let body_text = res.text().await.unwrap_or_default();
        let preview: String = body_text.chars().take(400).collect();
        eprintln!("[oauth_refresh] ← {status} {preview}");
        return Err(format!(
            "OAuth refresh failed (HTTP {}): {}",
            status.as_u16(),
            preview,
        ));
    }

    let parsed: OAuthRefreshResponse = res
        .json()
        .await
        .map_err(|e| format!("OAuth refresh response not JSON: {e}"))?;
    eprintln!("[oauth_refresh] ← 200 expires_in={}", parsed.expires_in);

    let new_access_token = parsed.access_token;
    let new_refresh_token = parsed.refresh_token.unwrap_or(refresh_token);
    let expires_at_ms = current_time_ms() + (parsed.expires_in as i64) * 1000;

    persist_refreshed_credentials(&new_access_token, &new_refresh_token, expires_at_ms)?;

    // Re-read through the same path the rest of the app uses, so the
    // returned blob reflects whatever was actually persisted (and the
    // caller doesn't have to trust our mapping logic).
    Ok(read_claude_code_credentials())
}

/// Persist a refreshed access/refresh token pair back into whichever
/// store the credentials originally came from. Tries the keychain first
/// (canonical on macOS), then the file (Linux/WSL).
fn persist_refreshed_credentials(
    access_token: &str,
    refresh_token: &str,
    expires_at_ms: i64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some((service, raw)) = read_macos_keychain_raw() {
            let updated = mutate_credentials_blob(&raw, access_token, refresh_token, expires_at_ms)
                .ok_or_else(|| "keychain blob is not parseable JSON".to_string())?;
            return write_macos_keychain(&service, &updated);
        }
    }

    if let Some((path, raw)) = read_credentials_file_raw() {
        let updated = mutate_credentials_blob(&raw, access_token, refresh_token, expires_at_ms)
            .ok_or_else(|| format!("credentials file at {} is not parseable JSON", path.display()))?;
        return std::fs::write(&path, updated)
            .map_err(|e| format!("failed to write credentials file at {}: {e}", path.display()));
    }

    Err(
        "no existing credential store found to write refreshed tokens into (no keychain entry, no credentials.json)"
            .to_string(),
    )
}

/// Mutate the OAuth blob in-place, preserving every field we don't care
/// about (scopes, subscriptionType, account, etc.). Handles both the
/// nested `claudeAiOauth.{accessToken,refreshToken,expiresAt}` schema
/// (macOS keychain canonical form, expiresAt in ms) and the flat
/// `{access_token,refresh_token,expires_at}` schema (credentials file
/// form, expires_at in seconds). Returns the re-serialized JSON, or
/// None if the input isn't valid JSON.
fn mutate_credentials_blob(
    raw: &str,
    access_token: &str,
    refresh_token: &str,
    expires_at_ms: i64,
) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let touched_nested = if let Some(oauth) = value.get_mut("claudeAiOauth") {
        if let Some(obj) = oauth.as_object_mut() {
            obj.insert(
                "accessToken".into(),
                serde_json::Value::String(access_token.into()),
            );
            obj.insert(
                "refreshToken".into(),
                serde_json::Value::String(refresh_token.into()),
            );
            obj.insert(
                "expiresAt".into(),
                serde_json::Value::Number(expires_at_ms.into()),
            );
            true
        } else {
            false
        }
    } else {
        false
    };

    if !touched_nested {
        let obj = value.as_object_mut()?;
        // File form: snake_case at top level, expires_at in seconds.
        obj.insert(
            "access_token".into(),
            serde_json::Value::String(access_token.into()),
        );
        obj.insert(
            "refresh_token".into(),
            serde_json::Value::String(refresh_token.into()),
        );
        obj.insert(
            "expires_at".into(),
            serde_json::Value::Number((expires_at_ms / 1000).into()),
        );
    }
    serde_json::to_string(&value).ok()
}

/// Keychain service names Claude Code has used for its credential item,
/// newest first. We read whichever exists and (on refresh) write the
/// rotated tokens back to that same service.
#[cfg(target_os = "macos")]
const CLAUDE_KEYCHAIN_SERVICES: [&str; 2] = ["Claude Code", "Claude Code-credentials"];

/// Raw keychain blob fetch — same shell-out as `read_macos_keychain` but
/// returns `(service, unparsed JSON)` so the refresh path can write back to
/// the service the blob actually came from without losing fields we don't model.
#[cfg(target_os = "macos")]
fn read_macos_keychain_raw() -> Option<(String, String)> {
    let account = macos_keychain_account();
    for service in CLAUDE_KEYCHAIN_SERVICES {
        let output = match std::process::Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                service,
                "-a",
                account.as_str(),
                "-w",
            ])
            .output()
        {
            Ok(o) => o,
            Err(_) => continue,
        };
        if !output.status.success() {
            continue;
        }
        if let Ok(blob) = String::from_utf8(output.stdout) {
            if !blob.trim().is_empty() {
                return Some((service.to_string(), blob));
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_keychain_account() -> String {
    let user = std::env::var("USER")
        .ok()
        .or_else(|| {
            std::process::Command::new("id")
                .arg("-un")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "claude-code-user".to_string());
    let sanitized: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if sanitized.is_empty() {
        "claude-code-user".to_string()
    } else {
        sanitized
    }
}

/// Write the credential blob back to the macOS keychain. Uses
/// `-U` so an existing entry is updated rather than rejected with
/// `errSecDuplicateItem`. On the first refresh after install the user
/// may see a keychain access prompt — same one they already accepted
/// for reads, but writes are a separate ACL gate.
#[cfg(target_os = "macos")]
fn write_macos_keychain(service: &str, blob: &str) -> Result<(), String> {
    let account = macos_keychain_account();
    let output = std::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account.as_str(),
            "-w",
            blob,
        ])
        .output()
        .map_err(|e| format!("keychain write failed to spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "keychain write failed (status {:?}): {}",
            output.status.code(),
            stderr.trim(),
        ));
    }
    Ok(())
}

/// Locate the credentials file and return `(path, contents)` so the
/// caller can mutate-and-write it. Returns None when no file exists.
fn read_credentials_file_raw() -> Option<(std::path::PathBuf, String)> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".claude").join(".credentials.json"),
        home.join(".claude").join("credentials.json"),
    ];
    for path in candidates.into_iter() {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            return Some((path, contents));
        }
    }
    None
}

/// Stream events emitted by `http_stream` over the Tauri Channel. The
/// JS side reassembles these into a fetch-shaped Response.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
enum HttpStreamEvent {
    /// First event — fires once headers are received.
    Headers {
        status: u16,
        status_text: String,
    },
    /// Body chunk, lossy-utf8 decoded.
    Data {
        chunk: String,
    },
    /// End of stream (clean close).
    End,
    /// Stream aborted with an error.
    Error {
        error: String,
    },
}

/// Server-to-server style HTTP request that streams the response body
/// back to the frontend over a Tauri Channel. Used by the LLM harnesses
/// to talk to api.anthropic.com etc. without going through the
/// webview's fetch (which forwards Origin and gets classified as a CORS
/// request — some Anthropic orgs deny CORS at the policy level).
///
/// Headers are passed straight through; the JS caller is responsible
/// for setting Authorization / Content-Type / Accept etc.
#[tauri::command]
async fn http_stream(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    on_event: Channel<HttpStreamEvent>,
) -> Result<(), String> {
    eprintln!(
        "[http_stream] → {} {} (body={} bytes, headers={})",
        method,
        url,
        body.as_deref().map(|b| b.len()).unwrap_or(0),
        headers.len(),
    );

    let client = reqwest::Client::builder()
        .user_agent(format!("desktop-oss/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            let msg = format!("client build failed: {e}");
            eprintln!("[http_stream] {msg}");
            msg
        })?;

    let method_parsed = method
        .parse::<reqwest::Method>()
        .map_err(|e| format!("invalid method `{method}`: {e}"))?;
    let mut req = client.request(method_parsed, &url);
    for (k, v) in headers.iter() {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("request failed: {e}");
            eprintln!("[http_stream] {msg}");
            let _ = on_event.send(HttpStreamEvent::Error { error: msg.clone() });
            return Err(msg);
        }
    };

    let status = res.status().as_u16();
    let status_text = res
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    eprintln!("[http_stream] ← {status} {status_text}");
    if on_event
        .send(HttpStreamEvent::Headers { status, status_text })
        .is_err()
    {
        eprintln!("[http_stream] receiver dropped after headers");
        return Ok(());
    }

    let mut stream = res.bytes_stream();
    let mut total_bytes = 0usize;
    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                total_bytes += bytes.len();
                let chunk = String::from_utf8_lossy(&bytes).into_owned();
                if on_event.send(HttpStreamEvent::Data { chunk }).is_err() {
                    eprintln!("[http_stream] receiver dropped mid-stream");
                    break;
                }
            }
            Err(e) => {
                eprintln!("[http_stream] stream error: {e}");
                let _ = on_event.send(HttpStreamEvent::Error {
                    error: format!("stream error: {e}"),
                });
                return Err(e.to_string());
            }
        }
    }
    eprintln!("[http_stream] end ({total_bytes} bytes total)");

    let _ = on_event.send(HttpStreamEvent::End);
    Ok(())
}

/// Events the JS side receives from `cli_stream` over a Tauri Channel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
enum CliStreamEvent {
    /// Subprocess started — confirms the binary was on PATH and exec'd.
    Spawned { pid: u32 },
    /// Lossy-utf8 chunk from stdout.
    Stdout { data: String },
    /// Lossy-utf8 chunk from stderr.
    Stderr { data: String },
    /// Subprocess exited cleanly. `code` is the exit status (None when
    /// killed by a signal).
    End { code: Option<i32> },
    /// Subprocess errored before / during run.
    Error { error: String },
}

/// Spawn a CLI as a subprocess and stream its stdout/stderr to the JS
/// frontend. Used by the CLI sidecar harnesses (claude / opencode /
/// codex) so the orchestrator's delegate can be a real coding agent
/// with full tool access via its own CLI.
///
/// Critical detail: stdin is wired to `Stdio::null()` so the child
/// immediately sees EOF on read. Tauri's plugin-shell keeps stdin as
/// an open pipe — many CLIs (opencode included) treat that as "more
/// input pending" and hang forever waiting for it.
#[tauri::command]
// `env` is an optional map of env vars merged on top of the inherited
// environment. Used to inject `NO_COLOR=1` / `TERM=dumb` so CLIs that
// auto-detect a TTY don't emit ANSI escape codes the chat surface can't
// render.
async fn cli_stream(
    binary: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    on_event: tauri::ipc::Channel<CliStreamEvent>,
) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    use tokio::process::Command as TokioCommand;

    eprintln!("[cli_stream] spawning: {} {:?}", binary, args);

    let mut cmd = TokioCommand::new(&binary);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(extra) = env {
        for (k, v) in extra {
            cmd.env(k, v);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn failed: {e}");
            eprintln!("[cli_stream] {msg}");
            let _ = on_event.send(CliStreamEvent::Error { error: msg.clone() });
            return Err(msg);
        }
    };

    if let Some(pid) = child.id() {
        let _ = on_event.send(CliStreamEvent::Spawned { pid });
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout pipe".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr pipe".to_string())?;

    // Raw byte read loop — forwards every chunk that arrives, including
    // ANSI escapes, partial lines, and CR-delimited progress updates.
    // `BufReader::lines()` was previously dropping output silently when a
    // CLI emitted non-newline-terminated bytes (e.g. opencode's TTY-style
    // progress) or hit an invalid-utf8 byte mid-read.
    let on_event_stdout = on_event.clone();
    let binary_for_stdout_log = binary.clone();
    let stdout_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => {
                    eprintln!("[cli_stream:{binary_for_stdout_log}] stdout EOF");
                    break;
                }
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    eprintln!(
                        "[cli_stream:{binary_for_stdout_log}] stdout +{n}B: {:?}",
                        chunk.chars().take(120).collect::<String>(),
                    );
                    if on_event_stdout
                        .send(CliStreamEvent::Stdout { data: chunk })
                        .is_err()
                    {
                        eprintln!(
                            "[cli_stream:{binary_for_stdout_log}] stdout channel dropped",
                        );
                        break;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[cli_stream:{binary_for_stdout_log}] stdout read error: {e}",
                    );
                    break;
                }
            }
        }
    });

    let on_event_stderr = on_event.clone();
    let binary_for_stderr_log = binary.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) => {
                    eprintln!("[cli_stream:{binary_for_stderr_log}] stderr EOF");
                    break;
                }
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    eprintln!(
                        "[cli_stream:{binary_for_stderr_log}] stderr +{n}B: {:?}",
                        chunk.chars().take(120).collect::<String>(),
                    );
                    if on_event_stderr
                        .send(CliStreamEvent::Stderr { data: chunk })
                        .is_err()
                    {
                        eprintln!(
                            "[cli_stream:{binary_for_stderr_log}] stderr channel dropped",
                        );
                        break;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[cli_stream:{binary_for_stderr_log}] stderr read error: {e}",
                    );
                    break;
                }
            }
        }
    });

    let status = match child.wait().await {
        Ok(s) => s,
        Err(e) => {
            let msg = format!("wait failed: {e}");
            eprintln!("[cli_stream] {msg}");
            let _ = on_event.send(CliStreamEvent::Error { error: msg.clone() });
            return Err(msg);
        }
    };
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let code = status.code();
    eprintln!("[cli_stream] exited code={code:?}");
    let _ = on_event.send(CliStreamEvent::End { code });
    Ok(())
}

/// Runtime info for invoking the Claude Code SDK sidecar. The frontend
/// uses this to pick the right spawn shape: in dev we run the .mjs via
/// `node` (fast iteration, no rebuild), in prod we run the
/// Bun-compiled standalone binary (no Node/Bun required on the user's
/// machine). The `claude_binary_path` field tells the sidecar where the
/// native `claude` executable lives — required in prod because the
/// SDK's `require.resolve()`-based auto-discovery only finds the binary
/// when its `node_modules/` sits adjacent to the sidecar script, which
/// isn't the case for a Bun-compiled standalone binary.
#[derive(Debug, Serialize)]
struct ClaudeAgentRuntime {
    /// Binary to spawn. In dev: `"node"` (must be on PATH).
    /// In prod: absolute path to the Bun-compiled sidecar binary.
    binary: String,
    /// Args prefix to prepend before the request JSON. In dev: `[path/to/index.mjs]`.
    /// In prod: `[]` (the binary already wraps the script).
    args_prefix: Vec<String>,
    /// Absolute path to the SDK's native `claude` executable, set as the
    /// `CLAUDE_AGENT_SDK_EXECUTABLE_PATH` env var when spawning. `None`
    /// in dev — the SDK auto-discovers via `node_modules/`.
    claude_binary_path: Option<String>,
    /// `"dev"` or `"prod"`. Surfaced to the TS layer for diagnostics —
    /// the path layout already encodes this, but a flat tag is easier
    /// to log.
    mode: &'static str,
}

#[tauri::command]
fn resolve_claude_agent_runtime(
    #[allow(unused_variables)] app: tauri::AppHandle,
) -> Result<ClaudeAgentRuntime, String> {
    if cfg!(debug_assertions) {
        // Dev: run the source .mjs via `node`. The SDK auto-resolves
        // its native binary from the adjacent node_modules/.
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "cannot find project root".to_string())?;
        let script = project_root
            .join("sidecar")
            .join("claude-agent")
            .join("index.mjs");
        if !script.exists() {
            return Err(format!(
                "sidecar script not found at {} — did you run `npm install` in sidecar/claude-agent/?",
                script.display(),
            ));
        }
        Ok(ClaudeAgentRuntime {
            binary: "node".into(),
            args_prefix: vec![script.to_string_lossy().into_owned()],
            claude_binary_path: None,
            mode: "dev",
        })
    } else {
        // Prod: Bun-compiled standalone binary + bundled native claude.
        // Both ship via `bundle.resources` in tauri.conf.json under
        // `claude-agent-bin/`.
        use tauri::Manager;
        let sidecar = app
            .path()
            .resolve(
                "claude-agent-bin/claude-agent-sidecar",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("sidecar binary resolve failed: {e}"))?;
        let claude = app
            .path()
            .resolve("claude-agent-bin/claude", tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("claude native binary resolve failed: {e}"))?;
        Ok(ClaudeAgentRuntime {
            binary: sidecar.to_string_lossy().into_owned(),
            args_prefix: vec![],
            claude_binary_path: Some(claude.to_string_lossy().into_owned()),
            mode: "prod",
        })
    }
}

/// npm-style platform tag (`<platform>-<arch>`, e.g. `darwin-x64`) naming
/// the `@cursor/sdk-<tag>` package. This matches `${process.platform}-${process.arch}`
/// in Node — which is exactly how `@cursor/sdk` builds the package name it
/// `require.resolve`s at runtime — so deriving it from the compile target
/// here keeps the Rust resolver and the bundled package name in sync.
/// `None` for targets that have no `@cursor/sdk-*` optional dependency.
fn cursor_sdk_platform_tag() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("windows", "x86_64") => "win32-x64",
        _ => return None,
    })
}

/// Runtime info for invoking the Cursor SDK sidecar. Same shape and dev/prod
/// split as `ClaudeAgentRuntime` — in dev we run the .mjs via `node`, in
/// prod we run the Bun-compiled standalone binary. The `native_bin_dir`
/// field tells the sidecar where the SDK's platform-specific native
/// binaries (`cursorsandbox`, `rg`) live so it can hand their paths to the
/// SDK in prod where `node_modules/` isn't adjacent to the sidecar.
#[derive(Debug, Serialize)]
struct CursorAgentRuntime {
    binary: String,
    args_prefix: Vec<String>,
    native_bin_dir: Option<String>,
    mode: &'static str,
}

#[tauri::command]
fn resolve_cursor_agent_runtime(
    #[allow(unused_variables)] app: tauri::AppHandle,
) -> Result<CursorAgentRuntime, String> {
    if cfg!(debug_assertions) {
        let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "cannot find project root".to_string())?;
        let script = project_root
            .join("sidecar")
            .join("cursor-agent")
            .join("index.mjs");
        if !script.exists() {
            return Err(format!(
                "sidecar script not found at {} — did you run `npm install` in sidecar/cursor-agent/?",
                script.display(),
            ));
        }
        Ok(CursorAgentRuntime {
            binary: "node".into(),
            args_prefix: vec![script.to_string_lossy().into_owned()],
            native_bin_dir: None,
            mode: "dev",
        })
    } else {
        // Prod: Bun-compiled standalone binary + a shipped
        // `node_modules/@cursor/sdk-<platform>/` tree so the SDK's
        // `require.resolve("@cursor/sdk-<platform>")` at runtime
        // succeeds and reaches the bundled `bin/cursorsandbox` and
        // `bin/rg`. We also surface the native-bin directory to the
        // sidecar via `native_bin_dir` so it can set
        // `CURSOR_RIPGREP_PATH` (the only override the SDK exposes
        // for ripgrep — cursorsandbox is found via the node_modules
        // resolution itself).
        use tauri::Manager;
        let sidecar = app
            .path()
            .resolve(
                "cursor-agent-bin/cursor-agent-sidecar",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("sidecar binary resolve failed: {e}"))?;
        // The bundle ships exactly the `@cursor/sdk-<tag>` package matching
        // the machine it was built on (see sidecar/stage.mjs). Derive the
        // same tag from the compile target so this resolves to the package
        // the SDK's runtime `require.resolve("@cursor/sdk-<tag>")` expects.
        let tag = cursor_sdk_platform_tag().ok_or_else(|| {
            format!(
                "no bundled @cursor/sdk for target {}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH,
            )
        })?;
        let bin_dir = app
            .path()
            .resolve(
                format!("cursor-agent-bin/node_modules/@cursor/sdk-{tag}/bin"),
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("native bin dir resolve failed: {e}"))?;
        Ok(CursorAgentRuntime {
            binary: sidecar.to_string_lossy().into_owned(),
            args_prefix: vec![],
            native_bin_dir: Some(bin_dir.to_string_lossy().into_owned()),
            mode: "prod",
        })
    }
}

/// Migrations for the local SQLite store. Run once on app startup by
/// tauri-plugin-sql. Schema-compatible with the future vector-memory
/// addition described in PLAN.md.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: include_str!("../migrations/0001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "delegate orchestration",
            sql: include_str!("../migrations/0002_delegate_orchestration.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "adapter session id",
            sql: include_str!("../migrations/0003_adapter_session_id.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "session directory",
            sql: include_str!("../migrations/0004_session_directory.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "module state",
            sql: include_str!("../migrations/0005_module_state.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "delegate role",
            sql: include_str!("../migrations/0006_delegate_role.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "dual-surface delegates",
            sql: include_str!("../migrations/0007_dual_surface.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:desktop-oss.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            read_file_base64,
            read_text_file,
            write_text_file,
            list_directory,
            home_dir,
            git_available,
            repo_status,
            read_claude_code_credentials,
            refresh_claude_code_credentials,
            http_stream,
            cli_stream,
            resolve_claude_agent_runtime,
            resolve_cursor_agent_runtime,
            list_skill_files,
            watch_skill_dirs,
            run_skill_shell,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_alive,
            tail_file,
            tail_stop,
            file_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
