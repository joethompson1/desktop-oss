// Synthetic round-trip tests for `historyToModelMessages`. Cheap — no DB,
// no LLM, no Tauri runtime. Each case constructs a `UIChatTurn[]` by hand
// and asserts on the projected `ModelMessage[]` shape.
//
// Run via:
//   npm run test:unit
//   tsx --test src/lib/agent/history-projection.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { historyToModelMessages } from "./history-projection.js";
import type {
  ToolPart,
  UIAssistantMessage,
  UIChatTurn,
  UIUserMessage,
} from "$lib/types/chat";

function userTurn(content: string, id = "u1"): UIUserMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: "2026-05-18T12:00:00Z",
  };
}

function assistantTurn(
  parts: UIAssistantMessage["parts"],
  id = "a1",
): UIAssistantMessage {
  return {
    id,
    role: "assistant",
    parts,
    createdAt: "2026-05-18T12:00:01Z",
  };
}

function completedToolPart(opts: {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
}): ToolPart {
  return {
    type: `tool-${opts.toolName}`,
    toolCallId: opts.toolCallId,
    state: "output-available",
    input: opts.input,
    output: opts.output,
  };
}

function erroredToolPart(opts: {
  toolName: string;
  toolCallId: string;
  input: unknown;
  errorText: string;
}): ToolPart {
  return {
    type: `tool-${opts.toolName}`,
    toolCallId: opts.toolCallId,
    state: "output-error",
    input: opts.input,
    errorText: opts.errorText,
  };
}

function inflightToolPart(opts: {
  toolName: string;
  toolCallId: string;
  input: unknown;
}): ToolPart {
  return {
    type: `tool-${opts.toolName}`,
    toolCallId: opts.toolCallId,
    state: "input-available",
    input: opts.input,
  };
}

describe("historyToModelMessages", () => {
  it("passes a user message through unchanged", () => {
    const history: UIChatTurn[] = [userTurn("hello")];
    const msgs = historyToModelMessages(history);
    assert.deepEqual(msgs, [{ role: "user", content: "hello" }]);
  });

  it("renders a text-only assistant turn as a parts array", () => {
    const history: UIChatTurn[] = [
      assistantTurn([{ type: "text", text: "hi there", state: "done" }]),
    ];
    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "assistant");
    assert.deepEqual(msgs[0].content, [{ type: "text", text: "hi there" }]);
  });

  it("emits a tool-call part AND a paired tool message for a completed call", () => {
    const history: UIChatTurn[] = [
      userTurn("spin up the lru implementation"),
      assistantTurn([
        { type: "text", text: "On it.", state: "done" },
        completedToolPart({
          toolName: "delegate_task",
          toolCallId: "call_1",
          input: { task: "implement LRU" },
          output: { type: "json", value: { status: "SUCCEEDED", summary: "done" } },
        }),
        { type: "text", text: "All wrapped up.", state: "done" },
      ]),
    ];

    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 3);

    assert.deepEqual(msgs[0], {
      role: "user",
      content: "spin up the lru implementation",
    });

    assert.equal(msgs[1].role, "assistant");
    assert.deepEqual(msgs[1].content, [
      { type: "text", text: "On it." },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "delegate_task",
        input: { task: "implement LRU" },
      },
      { type: "text", text: "All wrapped up." },
    ]);

    assert.equal(msgs[2].role, "tool");
    assert.deepEqual(msgs[2].content, [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "delegate_task",
        output: { type: "json", value: { status: "SUCCEEDED", summary: "done" } },
      },
    ]);
  });

  it("emits assistant tool-call only when there's no surrounding text", () => {
    const history: UIChatTurn[] = [
      assistantTurn([
        completedToolPart({
          toolName: "remember",
          toolCallId: "call_r",
          input: { content: "joe likes tabs" },
          output: { type: "json", value: { id: "m1" } },
        }),
      ]),
    ];

    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "assistant");
    assert.equal((msgs[0].content as Array<unknown>).length, 1);
    assert.equal(
      ((msgs[0].content as Array<{ type: string }>)[0]).type,
      "tool-call",
    );
    assert.equal(msgs[1].role, "tool");
  });

  it("drops an in-flight tool call (no output yet) to avoid orphan rejection", () => {
    const history: UIChatTurn[] = [
      assistantTurn([
        { type: "text", text: "Working on it…", state: "done" },
        inflightToolPart({
          toolName: "delegate_task",
          toolCallId: "call_inflight",
          input: { task: "long-running thing" },
        }),
      ]),
    ];

    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "assistant");
    assert.deepEqual(msgs[0].content, [{ type: "text", text: "Working on it…" }]);
  });

  it("drops an assistant turn that's *only* in-flight tool calls", () => {
    const history: UIChatTurn[] = [
      userTurn("kick that off"),
      assistantTurn([
        inflightToolPart({
          toolName: "delegate_task",
          toolCallId: "call_orphan",
          input: { task: "x" },
        }),
      ]),
    ];

    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
  });

  it("renders tool errors as a tool-result with error-text output", () => {
    const history: UIChatTurn[] = [
      assistantTurn([
        erroredToolPart({
          toolName: "read_file",
          toolCallId: "call_err",
          input: { path: "/nope" },
          errorText: "ENOENT: no such file or directory",
        }),
      ]),
    ];

    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].role, "tool");
    const tr = (msgs[1].content as Array<{ output: { type: string; value: string } }>)[0];
    assert.equal(tr.output.type, "error-text");
    assert.match(tr.output.value, /ENOENT/);
  });

  it("coerces a string output into { type: 'text' }", () => {
    const history: UIChatTurn[] = [
      assistantTurn([
        completedToolPart({
          toolName: "read_file",
          toolCallId: "call_str",
          input: { path: "/tmp/a" },
          output: "file contents go here",
        }),
      ]),
    ];

    const msgs = historyToModelMessages(history);
    const tr = (msgs[1].content as Array<{ output: { type: string; value: string } }>)[0];
    assert.deepEqual(tr.output, { type: "text", value: "file contents go here" });
  });

  it("wraps a plain object output as { type: 'json' }", () => {
    const history: UIChatTurn[] = [
      assistantTurn([
        completedToolPart({
          toolName: "recall",
          toolCallId: "call_json",
          input: { query: "tabs" },
          output: { results: [{ id: "m1", content: "joe likes tabs" }] },
        }),
      ]),
    ];

    const msgs = historyToModelMessages(history);
    const tr = (msgs[1].content as Array<{ output: { type: string; value: unknown } }>)[0];
    assert.equal(tr.output.type, "json");
    assert.deepEqual(tr.output.value, {
      results: [{ id: "m1", content: "joe likes tabs" }],
    });
  });

  it("ignores step-start parts", () => {
    const history: UIChatTurn[] = [
      assistantTurn([
        { type: "step-start" },
        { type: "text", text: "ok", state: "done" },
        { type: "step-start" },
      ]),
    ];
    const msgs = historyToModelMessages(history);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0].content, [{ type: "text", text: "ok" }]);
  });

  it("survives a realistic multi-turn delegate followthrough", () => {
    const history: UIChatTurn[] = [
      userTurn("research the failure mode in the LRU module", "u1"),
      assistantTurn(
        [
          { type: "text", text: "I'll spin up a researcher.", state: "done" },
          completedToolPart({
            toolName: "delegate_task",
            toolCallId: "call_r1",
            input: { task: "research", name: "researcher" },
            output: {
              type: "json",
              value: { runId: "r1", status: "SUCCEEDED", summary: "found a race condition" },
            },
          }),
          { type: "text", text: "Found a race condition.", state: "done" },
        ],
        "a1",
      ),
      userTurn("write the fix", "u2"),
      assistantTurn(
        [
          completedToolPart({
            toolName: "delegate_task",
            toolCallId: "call_r2",
            input: { task: "write fix" },
            output: { type: "json", value: { runId: "r2", status: "SUCCEEDED" } },
          }),
        ],
        "a2",
      ),
    ];

    const msgs = historyToModelMessages(history);
    // user, assistant(text+tool-call+text), tool, user, assistant(tool-call), tool
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "assistant", "tool", "user", "assistant", "tool"],
    );
    // First assistant turn has three parts in order
    assert.deepEqual(
      (msgs[1].content as Array<{ type: string }>).map((p) => p.type),
      ["text", "tool-call", "text"],
    );
    // Second tool message references call_r2
    assert.equal(
      (msgs[5].content as Array<{ toolCallId: string }>)[0].toolCallId,
      "call_r2",
    );
  });

  it("returns an empty array for empty history", () => {
    const msgs = historyToModelMessages([]);
    assert.deepEqual(msgs, []);
  });
});
