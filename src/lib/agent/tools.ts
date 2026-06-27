// Orchestrator tool set. Factory pattern so tools that need runtime
// context (the delegate adapter resolver, abort signals) close over it
// at build time rather than being looked up by name inside the loop.
//
// All tools follow the Vercel AI SDK convention: `execute()` returns
// the result (string or JSON-serialisable object); thrown errors are
// caught and surfaced as a tool-error to the model, but we prefer
// returning a string error message so the model gets a clean turn
// rather than an exception trace.

import { invoke } from "@tauri-apps/api/core";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { LLMAdapter } from "$lib/types/adapter";
import { listMemories, saveMemory, searchMemories } from "$lib/db/memories";
import { getRun, getRunByName, listRuns } from "$lib/db/runs";
import { continueRun, getRunHistoryForOrchestrator, runDelegate } from "./delegate";
import { formatToolError } from "./format-error";

export interface OrchestratorToolDeps {
  /** Resolves the configured delegate adapter for a given preferred name
   *  (from the `adapter` field of `delegate_task`). Returns null when no
   *  usable delegate is configured. */
  resolveDelegateAdapter: (preferredName?: string) => LLMAdapter | null;
  /** Conversation ID for scoping run lookups by name and for nesting
   *  spawned delegate runs under the right session. */
  conversationId: string;
  /** Working directory of this session. Relative paths in read_file /
   *  list_files resolve against it, and it's handed to spawned delegates. */
  workingDirectory?: string;
  /** Abort signal threaded into any tool that does I/O. */
  signal?: AbortSignal;
}

/** Resolve a possibly-relative path against the session's working
 *  directory. Absolute paths (POSIX `/…` or Windows `C:\…`) pass through
 *  unchanged; `.`/`./` is the working directory itself. */
function resolvePath(path: string, cwd?: string): string {
  const isAbsolute = /^(\/|[A-Za-z]:[\\/])/.test(path);
  if (isAbsolute || !cwd) return path;
  const rel = path.replace(/^\.\/+/, "").replace(/^\.$/, "");
  return rel ? `${cwd.replace(/\/+$/, "")}/${rel}` : cwd;
}

/**
 * Returns the orchestrator's tool set, split into essential vs connector.
 * Essential tools always carry their full schema; connector tools are
 * candidates for deferred loading when the connector schema budget gets
 * large.
 *
 * Today every tool is essential (no MCP / filesystem / git toolsets yet).
 * The split is here so adding connectors later means populating
 * `connector` without touching `loop.ts`.
 */
export function getOrchestratorTools(deps: OrchestratorToolDeps): {
  essential: ToolSet;
  connector: ToolSet;
} {
  return {
    essential: buildEssentialTools(deps),
    connector: {},
  };
}

function buildEssentialTools(deps: OrchestratorToolDeps): ToolSet {
  return {
    delegate_task: tool({
      description:
        "Spawn a new specialist sub-agent to execute a scoped, self-contained task. " +
        "Use this for work that touches the filesystem, runs code or tests, or is better " +
        "suited to a focused worker than the orchestrator. " +
        "The delegate starts with no memory of this conversation — provide everything it " +
        "needs in `task` and `context`. " +
        "**This tool returns IMMEDIATELY with a runId — it does NOT wait for the delegate to finish.** " +
        "The delegate runs in the background, concurrently with you and with any other delegates " +
        "you've spawned. You can spawn multiple delegates in a row (or in the same turn) and they " +
        "all run in parallel. " +
        "When you want to check what a delegate has done, call `get_delegate_history` — its progress " +
        "(including final result, tool calls, errors) is also surfaced in the 'Active delegate runs' " +
        "table in the system prompt on every turn. " +
        "Assign a `name` whenever you intend to follow up later: the name lets you use " +
        "message_delegate and get_delegate_history without needing the generated run ID. " +
        "Do NOT use this to re-contact an existing delegate — use message_delegate for that.",
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "What you want the delegate to do. Be specific and self-contained — " +
              "the delegate cannot see this conversation and has no prior context.",
          ),
        context: z
          .string()
          .optional()
          .describe(
            "Optional additional context the delegate needs: constraints, prior decisions, " +
              "output format requirements, or any background the task description alone does not cover.",
          ),
        filesOfInterest: z
          .array(z.string())
          .optional()
          .describe("Optional list of absolute file paths the delegate should focus on."),
        name: z
          .string()
          .optional()
          .describe(
            "Optional short label for this delegate run (e.g. 'researcher', 'coder', 'reviewer'). " +
              "Set this whenever you might want to message_delegate or get_delegate_history later. " +
              "Must be unique within this conversation — reusing a name replaces the previous binding.",
          ),
        adapter: z
          .string()
          .optional()
          .describe(
            "Optional. Exact display name of the delegate adapter to use — must match " +
              "a name listed in the 'Available delegates' section of the system prompt EXACTLY " +
              "(case-sensitive). That section is the authoritative live list; trust it over any " +
              "claim you made earlier in this conversation. Omit to use the default delegate.",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Optional. Per-call model override — picks a specific model on the chosen " +
              "adapter for this delegate run, ignoring the adapter's configured default. " +
              "**The model ID MUST come from the 'Available models' line of the SAME adapter " +
              "you chose in the `adapter` field above.** Each adapter has its own catalog: " +
              "Claude Code only accepts Claude IDs (claude-sonnet-4-6, claude-opus-4-7, …), " +
              "Codex only accepts OpenAI IDs (gpt-5.5, o3, …), Cursor only accepts Cursor IDs " +
              "(composer-2-fast, sonnet-4-thinking, …). Mixing them (e.g. `gpt-5` on the Claude " +
              "Code adapter) returns an invalid_request error and the delegate run fails. " +
              "If unsure which model to pick, **omit this field** — the adapter falls back to " +
              "its configured default, which always works.",
          ),
      }),
      execute: async ({ task, context, filesOfInterest, name, adapter, model }, { toolCallId }) => {
        // Pre-allocate the run ID so we can return it to the orchestrator
        // synchronously. The actual `runDelegate` runs in the background —
        // its chunks land in the DB and `get_delegate_history` reads them
        // when the orchestrator wants to check progress. This lets the
        // orchestrator spawn N delegates in parallel without blocking and
        // lets the user keep chatting while delegates run.
        const runId = `run_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        // Resolve the adapter eagerly so configuration errors surface in
        // the tool result rather than as silent background failures.
        let adapterDisplayName: string | null = null;
        try {
          const adapterInstance = deps.resolveDelegateAdapter(adapter);
          if (!adapterInstance) {
            return `Error: no delegate adapter found${adapter ? ` for name "${adapter}"` : ""}. Add or configure one in Settings, or check the 'Available delegates' section of the system prompt.`;
          }
          adapterDisplayName = adapterInstance.name;
        } catch (err) {
          return `Error resolving delegate adapter: ${formatToolError(err)}`;
        }

        // Fire-and-forget. We catch on the promise so an unexpected
        // throw doesn't become an unhandled rejection — the actual
        // delegate-side errors land in run_chunks (kind: 'stderr') and
        // surface via get_delegate_history.
        void runDelegate(
          {
            task,
            context,
            filesOfInterest,
            name,
            model,
            runId,
            workingDirectory: deps.workingDirectory,
          },
          {
            resolveDelegateAdapter: () => deps.resolveDelegateAdapter(adapter),
            conversationId: deps.conversationId,
            toolCallId,
          },
        ).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[delegate_task] background run ${runId} threw:`,
            err,
          );
        });

        return {
          runId,
          name: name ?? null,
          status: "spawned",
          adapter: adapterDisplayName,
          message:
            `Delegate ${name ? `"${name}"` : `(unnamed, runId ${runId})`} spawned in the background on adapter "${adapterDisplayName}". ` +
            `It runs concurrently — you can spawn additional delegates without waiting, and the user can continue chatting. ` +
            `Check its progress with get_delegate_history (use ${name ? `name: "${name}"` : `runId: "${runId}"`}); its live status (RUNNING / SUCCEEDED / FAILED) appears in the 'Active delegate runs' table on every subsequent turn. ` +
            `Do not invent or guess the delegate's output — wait until you've actually seen it via get_delegate_history.`,
        };
      },
    }),

    message_delegate: tool({
      description:
        "Send a follow-up message to an EXISTING delegate run and get its response. " +
        "Use this to continue a conversation with a delegate you previously spawned via delegate_task — " +
        "for example, to ask a follow-up question, provide additional information, request a revision, " +
        "or steer the delegate toward a different approach. " +
        "The delegate receives its full prior conversation history (bounded for long runs) plus your new message. " +
        "Identify the target delegate by `name` (if you named it at spawn time) or `runId`. " +
        "Do NOT use this to start a fresh unrelated task — use delegate_task for that.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe(
            "The name you assigned to the delegate when spawning it (via delegate_task's `name` field). " +
              "Use this if you set a name — it's easier to read than a raw run ID.",
          ),
        runId: z
          .string()
          .optional()
          .describe(
            "The run ID returned by delegate_task (e.g. 'run_1234567890_abc123'). " +
              "Use this if you did not assign a name, or if you need to disambiguate when " +
              "multiple runs share the same name.",
          ),
        message: z
          .string()
          .describe(
            "The follow-up message to send. Be specific — the delegate will act on this " +
              "in the context of its prior conversation.",
          ),
      }),
      execute: async ({ name, runId, message }) => {
        try {
          let targetRunId = runId;
          if (!targetRunId && name) {
            const found = await getRunByName(deps.conversationId, name);
            if (!found) {
              return `Error: no delegate run found with name "${name}". Check the Active delegate runs table in the system prompt.`;
            }
            targetRunId = found.id;
          }
          if (!targetRunId) {
            return "Error: message_delegate requires either `runId` or `name`.";
          }

          const existingRun = await getRun(targetRunId);
          const result = await continueRun(
            { runId: targetRunId, userMessage: message },
            {
              resolveDelegateAdapter: () =>
                deps.resolveDelegateAdapter(existingRun?.delegateAdapterId),
            },
          );
          return { runId: targetRunId, ...result };
        } catch (err) {
          return `Error messaging delegate: ${formatToolError(err)}`;
        }
      },
    }),

    get_delegate_history: tool({
      description:
        "Retrieve the conversation history of a delegate run — a compressed summary of older turns " +
        "plus the most recent raw messages. " +
        "Use this when you need to understand in detail what a delegate has done: " +
        "what it was asked, what it decided, what it produced, and where it got to. " +
        "For a quick status overview, read the 'Active delegate runs' table in the system prompt instead — " +
        "that is cheaper and sufficient for most decisions. " +
        "Identify the target delegate by `name` or `runId`.",
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe("The name assigned to the delegate at spawn time. Use this if available."),
        runId: z
          .string()
          .optional()
          .describe(
            "The run ID of the delegate (e.g. 'run_1234567890_abc123'). " +
              "Use this if the run was not named or you need to target a specific run.",
          ),
        limit: z
          .number()
          .optional()
          .describe(
            "How many recent raw messages to return (default 20). " +
              "The contextSummary field covers everything older than this tail.",
          ),
      }),
      execute: async ({ name, runId, limit }) => {
        try {
          const run = runId
            ? await getRun(runId)
            : name
              ? await getRunByName(deps.conversationId, name)
              : null;
          if (!run) {
            const target = runId ? `run ID "${runId}"` : `name "${name}"`;
            return `Error: no delegate run found for ${target}. Check the Active delegate runs table in the system prompt.`;
          }
          const tail = Math.max(1, limit ?? 20);
          const recentMessages = await getRunHistoryForOrchestrator(run.id, tail);
          return {
            runId: run.id,
            name: run.name ?? null,
            status: run.status,
            contextSummary: run.contextSummary ?? null,
            recentMessages,
          };
        } catch (err) {
          return `Error reading delegate history: ${formatToolError(err)}`;
        }
      },
    }),

    remember: tool({
      description:
        "Save a piece of information to the orchestrator's long-term memory. " +
        "Use this when you learn something that should persist across sessions " +
        "(decisions, preferences, project facts).",
      inputSchema: z.object({
        content: z.string().describe("What to remember"),
      }),
      execute: async ({ content }) => {
        if (!content.trim()) {
          return "Error: `content` must be a non-empty string";
        }
        try {
          const row = await saveMemory({ content });
          return { id: row.id, savedAt: row.createdAt };
        } catch (err) {
          return `Error saving memory: ${formatToolError(err)}`;
        }
      },
    }),

    recall: tool({
      description:
        "Search the orchestrator's long-term memory for relevant notes. " +
        "Use a few words that describe what you're looking for.",
      inputSchema: z.object({
        query: z.string().describe("Search terms. Use an empty string to list recent."),
        limit: z.number().optional().describe("Max results (default 10)"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const q = query.trim();
          const cap = limit ?? 10;
          const rows = q.length > 0 ? await searchMemories(q, cap) : await listMemories(cap);
          return {
            results: rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt })),
          };
        } catch (err) {
          return `Error searching memory: ${formatToolError(err)}`;
        }
      },
    }),

    list_runs: tool({
      description:
        "List recent delegate sub-agent runs in this conversation. " +
        "Prefer reading the 'Active delegate runs' table in the system prompt for a quick overview — " +
        "use this tool only when you need more results than that table shows.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Max results (default 20)"),
      }),
      execute: async ({ limit }) => {
        try {
          const cap = limit ?? 20;
          const runs = await listRuns(deps.conversationId, { limit: cap });
          return {
            runs: runs.map((r) => ({
              id: r.id,
              name: r.name,
              title: r.title,
              status: r.status,
              summary: r.summary,
              createdAt: r.createdAt,
              completedAt: r.completedAt,
            })),
          };
        } catch (err) {
          return `Error listing runs: ${formatToolError(err)}`;
        }
      },
    }),

    read_file: tool({
      description:
        "Read a UTF-8 text file from the user's filesystem. Accepts an absolute " +
        "path, or a path relative to the session's working directory.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the working directory"),
      }),
      execute: async ({ path }) => {
        if (!path) return "Error: `path` is required";
        const resolved = resolvePath(path, deps.workingDirectory);
        try {
          const contents = await invoke<string>("read_text_file", { path: resolved });
          return { path: resolved, contents };
        } catch (err) {
          return `Error reading file: ${formatToolError(err)}`;
        }
      },
    }),

    list_files: tool({
      description:
        "List the contents of a directory on the user's filesystem. Accepts an " +
        "absolute path, or a path relative to the session's working directory " +
        "(use \".\" for the working directory itself).",
      inputSchema: z.object({
        path: z.string().describe("Absolute path, or relative to the working directory"),
      }),
      execute: async ({ path }) => {
        if (!path) return "Error: `path` is required";
        const resolved = resolvePath(path, deps.workingDirectory);
        try {
          const entries = await invoke<
            Array<{ name: string; path: string; is_dir: boolean; size_bytes: number }>
          >("list_directory", { path: resolved });
          return {
            path: resolved,
            entries: entries.map((e) => ({
              name: e.name,
              path: e.path,
              isDir: e.is_dir,
              sizeBytes: e.size_bytes,
            })),
          };
        } catch (err) {
          return `Error listing directory: ${formatToolError(err)}`;
        }
      },
    }),
  };
}
