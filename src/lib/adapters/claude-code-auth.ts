// Read Claude Code OAuth credentials from `~/.claude/.credentials.json`.
// When the user has authenticated with `claude auth login`, we can reuse
// those tokens to talk to api.anthropic.com against their subscription —
// no separate API key required.

import { invoke } from "@tauri-apps/api/core";

export interface ClaudeCodeAccountInfo {
  hasCredentials: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: unknown;
  email: string | null;
}

interface RawCreds {
  has_credentials: boolean;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: unknown;
  email: string | null;
}

export async function readClaudeCodeCredentials(): Promise<ClaudeCodeAccountInfo> {
  const raw = await invoke<RawCreds>("read_claude_code_credentials");
  return {
    hasCredentials: raw.has_credentials,
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: raw.expires_at,
    email: raw.email,
  };
}

/** Exchange the cached refresh token for a fresh access token against
 *  Anthropic's OAuth endpoint, persisting the rotated pair back into the
 *  keychain (macOS) or credentials file (Linux/WSL). Throws when the
 *  refresh fails — typically because the refresh token itself has been
 *  revoked, in which case the user really does need to `claude auth
 *  login` again. */
export async function refreshClaudeCodeCredentials(
  refreshToken: string,
): Promise<ClaudeCodeAccountInfo> {
  const raw = await invoke<RawCreds>("refresh_claude_code_credentials", {
    refreshToken,
  });
  return {
    hasCredentials: raw.has_credentials,
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: raw.expires_at,
    email: raw.email,
  };
}

/** Best-effort check whether the cached access token has expired.
 *  expires_at may be a unix-seconds number, a unix-millis number, or an
 *  ISO date string depending on the Claude CLI version. */
export function isAccessTokenExpired(expiresAt: unknown): boolean {
  if (expiresAt == null) return false;
  let expiryMs: number | null = null;
  if (typeof expiresAt === "number") {
    expiryMs = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  } else if (typeof expiresAt === "string") {
    const asNum = Number(expiresAt);
    if (!Number.isNaN(asNum)) {
      expiryMs = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      const parsed = Date.parse(expiresAt);
      expiryMs = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (expiryMs == null) return false;
  // Treat anything within a 60-second grace window as expired so we refresh
  // proactively rather than racing the wire.
  return expiryMs < Date.now() + 60_000;
}

/**
 * Read credentials and refresh them transparently if the access token is
 * expired (or nearly so). Returns a credential blob whose `accessToken` is
 * safe to use against api.anthropic.com.
 *
 * Behaviour:
 *   - No login at all → returns the empty blob (`hasCredentials: false`).
 *     Caller is responsible for surfacing "run claude auth login" to the
 *     user.
 *   - Login present, token fresh → returns it as-is, no network call.
 *   - Login present, token expired, refresh_token present → POSTs to
 *     Anthropic's OAuth endpoint, writes the rotated pair back to the
 *     keychain/file, and returns the new credentials.
 *   - Login present, token expired, refresh fails or no refresh_token →
 *     throws with a message instructing the user to re-run `claude auth
 *     login`. This is the *real* "you need to log in again" case, not the
 *     spurious one the old code threw on every expiry.
 */
export async function getValidClaudeCodeCredentials(): Promise<ClaudeCodeAccountInfo> {
  const creds = await readClaudeCodeCredentials();
  if (!creds.hasCredentials || !creds.accessToken) return creds;
  if (!isAccessTokenExpired(creds.expiresAt)) return creds;
  if (!creds.refreshToken) {
    throw new Error(
      "Claude Code access token has expired and no refresh token is cached. Re-run `claude auth login` to refresh.",
    );
  }
  try {
    return await refreshClaudeCodeCredentials(creds.refreshToken);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Claude Code OAuth refresh failed (${detail}). Re-run \`claude auth login\` to re-authenticate.`,
    );
  }
}
