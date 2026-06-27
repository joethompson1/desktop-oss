// Cursor SDK sidecar — invoked by the Tauri host with a JSON request
// in argv[2]. Loads `@cursor/sdk`, creates (or resumes) an Agent, sends
// the prompt, and relays both fine-grained `InteractionUpdate` deltas
// (token-by-token text, tool-call lifecycle, thinking) AND
// coarse-grained `SDKMessage` events from the run stream as NDJSON to
// stdout. The host adapter parses the NDJSON back into ChatStreamPart
// events.
//
// Each emitted line is wrapped so the host can distinguish event kinds:
//   { kind: "delta",   update: InteractionUpdate }
//   { kind: "message", message: SDKMessage }
//   { kind: "agent_ready", agent_id: string }
//   { kind: "result",  status: RunResultStatus, result?: string,
//                       durationMs?: number }
//   { kind: "error",   error: string }
//
// On unrecoverable error the process writes one `error` line and exits 1.
// On success exits 0 after emitting `result`.

import { Agent } from "@cursor/sdk";
import path from "node:path";

// Production resource layout: the Tauri host bundles the platform
// package's `bin/cursorsandbox` + `bin/rg` into a sibling
// `node_modules/@cursor/sdk-<platform>/bin/` tree next to this binary,
// and sets `CURSOR_SDK_NATIVE_BIN_DIR` to point at that bin/ dir.
//
// `CURSOR_RIPGREP_PATH` is the only override the SDK exposes via env
// var — set it so the SDK doesn't fall back to a PATH lookup that
// would miss the bundled binary. `cursorsandbox` has no equivalent
// override; the SDK locates it via `require.resolve("@cursor/sdk-…")`
// which works because we ship the node_modules tree alongside.
const nativeBinDir = process.env.CURSOR_SDK_NATIVE_BIN_DIR;
if (nativeBinDir && !process.env.CURSOR_RIPGREP_PATH) {
  process.env.CURSOR_RIPGREP_PATH = path.join(nativeBinDir, "rg");
}

const raw = process.argv[2];
if (!raw) {
  process.stderr.write("cursor-agent-sidecar: no request JSON in argv[2]\n");
  process.exit(1);
}

let request;
try {
  request = JSON.parse(raw);
} catch (err) {
  process.stderr.write(
    `cursor-agent-sidecar: failed to parse request: ${err?.message ?? err}\n`,
  );
  process.exit(1);
}

const { prompt, options: requestOptions = {} } = request;
if (typeof prompt !== "string" || !prompt.length) {
  process.stderr.write('cursor-agent-sidecar: request missing "prompt"\n');
  process.exit(1);
}

const {
  apiKey,
  model,
  cwd,
  resumeAgentId,
} = requestOptions;

if (!apiKey || typeof apiKey !== "string") {
  emit({
    kind: "error",
    error:
      "Cursor SDK requires an API key. Generate one at Cursor Dashboard → Integrations → User API Keys and set it on the adapter in Settings.",
  });
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const abortController = new AbortController();
process.on("SIGINT", () => abortController.abort());
process.on("SIGTERM", () => abortController.abort());

async function main() {
  let agent;
  try {
    if (resumeAgentId) {
      agent = await Agent.resume(resumeAgentId, { apiKey });
    } else {
      const createOpts = {
        apiKey,
        ...(model ? { model: { id: model } } : {}),
        local: {
          ...(cwd ? { cwd } : {}),
        },
      };
      agent = await Agent.create(createOpts);
    }
  } catch (err) {
    emit({
      kind: "error",
      error: `Agent.${resumeAgentId ? "resume" : "create"} failed: ${stringifyErr(err)}`,
    });
    process.exit(1);
  }

  emit({ kind: "agent_ready", agent_id: agent.agentId });

  let run;
  try {
    run = await agent.send(prompt, {
      onDelta: ({ update }) => {
        try {
          emit({ kind: "delta", update });
        } catch {
          // Best-effort — failing to forward a delta shouldn't kill the run.
        }
      },
    });
  } catch (err) {
    emit({ kind: "error", error: `agent.send failed: ${stringifyErr(err)}` });
    try {
      agent.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  // Pump the SDKMessage stream concurrently with the delta callback so we
  // surface init / tool-call / status / final-result message events. The
  // delta callback already covers granular text streaming, so this stream
  // is mostly used for run-level metadata and tool-call envelopes.
  const streamPump = (async () => {
    try {
      for await (const msg of run.stream()) {
        emit({ kind: "message", message: msg });
      }
    } catch (err) {
      emit({
        kind: "error",
        error: `run.stream() failed: ${stringifyErr(err)}`,
      });
    }
  })();

  let result;
  try {
    result = await run.wait();
  } catch (err) {
    emit({ kind: "error", error: `run.wait() failed: ${stringifyErr(err)}` });
    try {
      agent.close();
    } catch {
      // ignore
    }
    process.exit(1);
  }

  // Make sure the stream pump has drained before we emit the terminal
  // event. Without this, in-flight `message` lines could race the
  // `result` line and arrive after it.
  await streamPump.catch(() => {});

  emit({
    kind: "result",
    status: result.status,
    result: result.result,
    durationMs: result.durationMs,
  });

  try {
    agent.close();
  } catch {
    // ignore
  }
  process.exit(result.status === "error" ? 1 : 0);
}

function stringifyErr(err) {
  if (err instanceof Error) return err.message || err.toString();
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

main().catch((err) => {
  emit({ kind: "error", error: `unhandled: ${stringifyErr(err)}` });
  process.exit(1);
});
