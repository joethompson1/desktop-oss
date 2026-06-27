// Shared constants + helpers for impersonating the official `claude` CLI
// when calling /v1/messages with an OAuth token. Without these, Anthropic's
// anti-abuse layer aggressively rate-limits OAuth-token requests — returning
// 429 with an empty "Error" message even when the account has remaining quota.
//
// Source: github.com/.../claude-code (src/services/api/client.ts,
// src/utils/http.ts, src/utils/betas.ts, src/constants/oauth.ts,
// src/utils/fingerprint.ts).

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// Beta header values used by the CLI. Order matches the CLI's `betas`
// array assembly: claude-code first, then oauth, then optional 1M-context.
export const CLAUDE_CODE_BETA = "claude-code-20250219";
export const OAUTH_BETA = "oauth-2025-04-20";
export const PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";

// User-Agent format: `claude-cli/<version> (<USER_TYPE>, <ENTRYPOINT>, ...)`.
// External users have no USER_TYPE env var, so the CLI itself sends the
// literal string "external" in that slot — mirror exactly.
export const CLAUDE_CLI_VERSION = "2.1.138";
export const CLAUDE_CLI_USER_AGENT =
  `claude-cli/${CLAUDE_CLI_VERSION} (external, cli, client-app/clive-desktop-oss/0.1.0)`;

// Stable per-app-session UUID matching what the CLI's
// `X-Claude-Code-Session-Id` header sends. Generated once at module load —
// same lifetime as the orchestrator chat, regenerated on app restart.
export const SESSION_ID = (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Hardcoded salt from the Claude Code backend's validation. The server
// recomputes this fingerprint from the first user message and the declared
// cc_version, then compares.
const FINGERPRINT_SALT = "59cf53e54c78";

/**
 * Compute the 3-char hex fingerprint Claude Code stamps into its
 * `x-anthropic-billing-header` system-prompt line.
 *
 * Algorithm (must match upstream exactly):
 *   chars  = msg[4] + msg[7] + msg[20]  (each falling back to '0')
 *   input  = SALT + chars + version
 *   digest = SHA256(input)
 *   return digest.slice(0, 3)   // 3 hex chars
 */
export async function computeFingerprint(
  messageText: string,
  version: string = CLAUDE_CLI_VERSION,
): Promise<string> {
  const chars = [4, 7, 20].map((i) => messageText[i] ?? "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 3);
}

/**
 * Build the line Claude Code prepends to the system prompt so the
 * Anthropic API can attribute the request to a specific client. The
 * server side parses this from the prompt body — not from HTTP headers —
 * to decide whether to apply the anti-abuse rate limiter.
 *
 * We omit the `cch=` attestation token. That field is only populated by
 * Bun's native HTTP stack with `NATIVE_CLIENT_ATTESTATION` enabled —
 * other clients can omit it without the server rejecting the call.
 */
export async function buildBillingHeaderLine(
  firstUserMessage: string,
): Promise<string> {
  const fingerprint = await computeFingerprint(firstUserMessage);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${fingerprint}; cc_entrypoint=cli;`;
}
