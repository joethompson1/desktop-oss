/**
 * Turn whatever a tool's `catch` receives into a human-readable string.
 *
 * Tauri's `invoke` rejects with the *serialized* `Err` value, not an
 * `Error`. The Rust `FsError` enum serializes (via
 * `#[serde(tag = "kind", content = "message")]`) to `{ kind, message }`,
 * so a plain `String(err)` yields the useless `"[object Object]"`. This
 * normalizes the common shapes so the model sees the real reason
 * (e.g. `NotFound: /Users/foo/bar`) instead.
 */
export function formatToolError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const kind = typeof rec.kind === "string" ? rec.kind : undefined;
    const message =
      typeof rec.message === "string"
        ? rec.message
        : rec.message != null
          ? JSON.stringify(rec.message)
          : undefined;
    if (kind && message) return `${kind}: ${message}`;
    if (kind) return kind;
    if (message) return message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
