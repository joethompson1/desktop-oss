// Generic JSON-RPC 2.0 over stdio MCP client. Owns one long-lived
// subprocess (e.g. `codex mcp-server`) and multiplexes concurrent
// `tools/call` requests over it, routing notifications back to the
// originating call via the MCP `_meta.requestId` field.
//
// Uses `@tauri-apps/plugin-shell`'s Command.spawn() — its child handle
// exposes `child.write()` for bidirectional stdio and emits per-line
// stdout events, which is exactly the shape we need for a JSON-RPC
// peer.
//
// Lifecycle:
//   const client = new McpStdioClient({ binary: "codex", args: ["mcp-server"] });
//   await client.start();           // spawn + initialize handshake
//   for await (const evt of client.callTool("codex", {...})) { … }
//   await client.stop();            // SIGTERM, drain pending calls

import { Command, type Child } from "@tauri-apps/plugin-shell";

const PROTOCOL_VERSION = "2024-11-05";

/** One event emitted by an in-flight `callTool()` iterator. */
export type McpToolCallEvent =
  | {
      kind: "notification";
      method: string;
      params: Record<string, unknown>;
    }
  | { kind: "result"; result: unknown }
  | {
      kind: "error";
      error: { code: number; message: string; data?: unknown };
    };

export interface McpClientOptions {
  binary: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Identifier sent in the initialize handshake's `clientInfo`. */
  clientName?: string;
  clientVersion?: string;
}

export interface McpServerInfo {
  name: string;
  title?: string;
  version: string;
  protocolVersion: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingCall {
  push: (evt: McpToolCallEvent) => void;
  end: () => void;
  fail: (err: Error) => void;
}

export class McpStdioClient {
  readonly #opts: McpClientOptions;
  #command: Command<string> | null = null;
  #child: Child | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #serverInfo: McpServerInfo | null = null;
  #starting: Promise<void> | null = null;
  #closed = false;

  constructor(opts: McpClientOptions) {
    this.#opts = opts;
  }

  get serverInfo(): McpServerInfo | null {
    return this.#serverInfo;
  }

  isRunning(): boolean {
    return this.#child !== null && !this.#closed;
  }

  /** Spawn the subprocess and complete the MCP initialize handshake.
   *  Concurrent callers share one in-flight start. Subsequent calls
   *  after a successful start are no-ops. */
  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart();
    try {
      await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async #doStart(): Promise<void> {
    this.#closed = false;
    const spawnOpts: { env?: Record<string, string>; cwd?: string } = {};
    if (this.#opts.env) spawnOpts.env = this.#opts.env;
    if (this.#opts.cwd) spawnOpts.cwd = this.#opts.cwd;

    this.#command = Command.create(
      this.#opts.binary,
      this.#opts.args ?? [],
      spawnOpts,
    );

    this.#command.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#command.stderr.on("data", (chunk: string) => this.#onStderr(chunk));
    this.#command.on("close", () => this.#onClose());
    this.#command.on("error", (err: string) => this.#onError(err));

    try {
      this.#child = await this.#command.spawn();
    } catch (err) {
      this.#command = null;
      throw new Error(
        `Failed to spawn \`${this.#opts.binary}\`: ${stringifyErr(err)}`,
      );
    }

    let initResult: {
      protocolVersion: string;
      capabilities?: unknown;
      serverInfo: McpServerInfo;
    };
    try {
      initResult = (await this.#oneShotRpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.#opts.clientName ?? "clive-desktop-oss",
          version: this.#opts.clientVersion ?? "0.1",
        },
      })) as {
        protocolVersion: string;
        capabilities?: unknown;
        serverInfo: McpServerInfo;
      };
    } catch (err) {
      await this.stop();
      throw err;
    }

    this.#serverInfo = {
      name: initResult.serverInfo?.name ?? this.#opts.binary,
      title: initResult.serverInfo?.title,
      version: initResult.serverInfo?.version ?? "0.0.0",
      protocolVersion: initResult.protocolVersion,
    };

    await this.#sendNotification("notifications/initialized");
  }

  async stop(): Promise<void> {
    this.#closed = true;
    const err = new Error("MCP client stopped");
    for (const pump of this.#pending.values()) pump.fail(err);
    this.#pending.clear();
    if (this.#child) {
      try {
        await this.#child.kill();
      } catch {
        // ignore — process may already be dead
      }
      this.#child = null;
    }
    this.#command = null;
  }

  /** Call a server tool. Yields notifications scoped to this call (matched
   *  via `params._meta.requestId`) followed by exactly one terminating
   *  `result` or `error` event. Cancelling via `signal` sends a
   *  `notifications/cancelled` and rejects the iterator. */
  callTool(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<McpToolCallEvent> {
    return this.#callWithEvents(
      "tools/call",
      { name, arguments: args },
      opts,
    );
  }

  async *#callWithEvents(
    method: string,
    params: unknown,
    opts: { signal?: AbortSignal },
  ): AsyncGenerator<McpToolCallEvent> {
    if (!this.isRunning()) {
      throw new Error("MCP client not started (call start() first)");
    }
    const id = this.#nextId++;
    const queue: McpToolCallEvent[] = [];
    let waiter: (() => void) | null = null;
    let ended = false;
    let error: Error | null = null;

    this.#pending.set(id, {
      push(evt) {
        queue.push(evt);
        waiter?.();
        waiter = null;
      },
      end() {
        ended = true;
        waiter?.();
        waiter = null;
      },
      fail(err) {
        error = err;
        waiter?.();
        waiter = null;
      },
    });

    let abortHandler: (() => void) | null = null;
    if (opts.signal) {
      abortHandler = () => {
        void this.#sendNotification("notifications/cancelled", {
          requestId: id,
        }).catch(() => {});
        this.#pending.get(id)?.fail(new Error("aborted"));
      };
      opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      await this.#sendRaw({ jsonrpc: "2.0", id, method, params });
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (error) throw error;
        if (ended) return;
        await new Promise<void>((r) => {
          waiter = r;
        });
      }
    } finally {
      this.#pending.delete(id);
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  async #oneShotRpc(method: string, params: unknown): Promise<unknown> {
    for await (const evt of this.#callWithEvents(method, params, {})) {
      if (evt.kind === "result") return evt.result;
      if (evt.kind === "error") {
        throw new Error(
          `MCP RPC error (${evt.error.code}) on ${method}: ${evt.error.message}`,
        );
      }
      // Notifications during handshake are unusual but harmless — ignore.
    }
    throw new Error(`MCP RPC ${method} ended without result`);
  }

  async #sendNotification(method: string, params?: unknown): Promise<void> {
    await this.#sendRaw({ jsonrpc: "2.0", method, params });
  }

  async #sendRaw(
    payload: JsonRpcRequest | JsonRpcNotification,
  ): Promise<void> {
    if (!this.#child) {
      throw new Error("MCP client not running");
    }
    const text = JSON.stringify(payload) + "\n";
    try {
      await this.#child.write(text);
    } catch (err) {
      // Tauri IPC rejections often arrive as strings (e.g. permission
      // denials like "shell.stdin_write not allowed"), not Error
      // instances. Wrap so callers that check `instanceof Error` don't
      // silently swallow the underlying detail.
      throw new Error(
        `Failed to write to \`${this.#opts.binary}\` stdin: ${stringifyErr(err)}`,
      );
    }
  }

  #onStdout(chunk: string): void {
    // The plugin-shell normally emits per-line in text encoding, but
    // defensively split on `\n` to handle batched lines or trailing
    // partial bytes from buffered IO.
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.#handleLine(trimmed);
    }
  }

  #handleLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp-client:${this.#opts.binary}] non-JSON stdout:`,
        line.slice(0, 200),
      );
      return;
    }
    if (typeof obj !== "object" || obj === null) return;
    const record = obj as Record<string, unknown>;

    if (
      "id" in record &&
      ("result" in record || "error" in record)
    ) {
      const id = record.id;
      if (typeof id !== "number") return;
      const pending = this.#pending.get(id);
      if (!pending) return;
      if ("error" in record && record.error) {
        pending.push({
          kind: "error",
          error: record.error as McpToolCallEvent extends { kind: "error"; error: infer E } ? E : never,
        });
      } else {
        pending.push({ kind: "result", result: record.result });
      }
      pending.end();
      return;
    }

    if (typeof record.method === "string") {
      const params = (record.params ?? {}) as Record<string, unknown>;
      const meta = params._meta as
        | { requestId?: number | string }
        | undefined;
      const reqIdRaw = meta?.requestId;
      const reqId =
        typeof reqIdRaw === "number"
          ? reqIdRaw
          : typeof reqIdRaw === "string"
            ? Number(reqIdRaw)
            : undefined;
      if (reqId !== undefined && Number.isFinite(reqId)) {
        const pending = this.#pending.get(reqId);
        if (pending) {
          pending.push({
            kind: "notification",
            method: record.method,
            params,
          });
        }
        return;
      }
      // Unscoped notification (e.g. tools/list_changed) — log and ignore.
      // eslint-disable-next-line no-console
      console.debug(
        `[mcp-client:${this.#opts.binary}] unscoped notification: ${record.method}`,
      );
    }
  }

  #onStderr(chunk: string): void {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    // eslint-disable-next-line no-console
    console.debug(
      `[mcp-client:${this.#opts.binary}] stderr: ${trimmed.slice(0, 400)}`,
    );
  }

  #onClose(): void {
    this.#closed = true;
    const err = new Error(`MCP server subprocess (${this.#opts.binary}) exited`);
    for (const pump of this.#pending.values()) pump.fail(err);
    this.#pending.clear();
    this.#child = null;
  }

  #onError(msg: string): void {
    // eslint-disable-next-line no-console
    console.error(`[mcp-client:${this.#opts.binary}] error: ${msg}`);
    const err = new Error(`MCP server error: ${msg}`);
    for (const pump of this.#pending.values()) pump.fail(err);
    this.#pending.clear();
  }
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message || err.toString();
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      // fall through to String()
    }
  }
  return String(err);
}
