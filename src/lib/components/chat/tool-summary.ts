/**
 * Produce a "verb / detail" pair for a tool call, used as the collapsed
 * header text. Ported from desktop-oss's cockpit and extended with the
 * orchestrator-tool names this app surfaces (delegate_task, remember,
 * recall, list_files, list_runs).
 */

export interface VerbDetail {
  verb: string;
  detail: string;
}

export function summarizeToolCall(
  name: string | null,
  input: Record<string, unknown> | null | undefined,
): VerbDetail {
  const safe = name ?? "Called a tool";
  if (!input || typeof input !== "object") {
    return { verb: safe, detail: "" };
  }
  const str = (k: string): string =>
    typeof input[k] === "string" ? (input[k] as string) : "";

  switch (safe) {
    // ─── Normalized run events (Plan 03) ────────────────────────────────
    case "todo_update": {
      const items = Array.isArray(input.items)
        ? (input.items as Array<{ status?: unknown }>)
        : [];
      const done = items.filter((i) => i && i.status === "completed").length;
      return {
        verb: "Updated todos",
        detail: items.length ? `${done}/${items.length} done` : "",
      };
    }
    case "turn": {
      const reason = str("finishReason");
      const label =
        reason === "length"
          ? "Response truncated"
          : reason === "content_filter"
            ? "Response filtered"
            : reason === "error"
              ? "Turn errored"
              : "Turn ended abnormally";
      return {
        verb: `⚠ ${label}`,
        detail: reason === "length" ? "max output tokens" : "",
      };
    }

    // ─── Orchestrator-built-in tools (this app) ─────────────────────────
    case "delegate_task": {
      const task = str("task");
      // First line of the task brief is the most useful summary.
      const firstLine = task.split("\n")[0]?.trim() ?? "";
      return { verb: "Delegated task", detail: firstLine };
    }
    case "remember":
      return { verb: "Remembered", detail: str("content") };
    case "recall":
      return { verb: "Recalled", detail: str("query") };
    case "read_file":
      return { verb: "Read", detail: str("path") };
    case "list_files":
      return { verb: "Listed", detail: str("path") };
    case "list_runs":
      return { verb: "Listed runs", detail: "" };

    // ─── Claude Code tool names (in case the delegate uses CC tools) ───
    case "Read":
      return { verb: "Read", detail: str("path") || str("file_path") };
    case "Write":
      return { verb: "Wrote", detail: str("path") || str("file_path") };
    case "Edit":
    case "MultiEdit":
      return { verb: "Edited", detail: str("path") || str("file_path") };
    case "Bash":
      return { verb: "Ran", detail: str("command") };
    case "Glob":
      return { verb: "Found", detail: str("pattern") };
    case "Grep":
      return { verb: "Searched", detail: str("pattern") };
    case "WebFetch":
    case "WebSearch":
      return { verb: "Fetched", detail: str("url") || str("query") };
    case "Task":
      return { verb: "Task", detail: str("description") || str("prompt") };
    case "TodoWrite":
      return { verb: "Updated todos", detail: "" };
    case "LS":
      return { verb: "Listed", detail: str("path") };

    default:
      return { verb: safe, detail: "" };
  }
}
