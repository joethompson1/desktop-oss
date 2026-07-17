// Unit tests for the pure TUI-mirror pieces: transcript-line parsing,
// relay parsing, hook-settings generation, and the project-path munge.
// Runs under `npm run test:unit` (tsx --test).

import { test } from "node:test";
import assert from "node:assert/strict";

import { LineBuffer, parseTranscriptLine } from "./transcript";
import {
  buildHookSettings,
  fallbackTranscriptPath,
  mungeProjectPath,
  parseRelayLine,
} from "./hooks";

const NONE = new Set<string>();

test("user line with string content becomes a user_message chunk", () => {
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: "explain recursion" },
  });
  const { chunks } = parseTranscriptLine(line, NONE);
  assert.deepEqual(chunks, [
    { kind: "user_message", text: "explain recursion" },
  ]);
});

test("meta and synthetic user lines are skipped", () => {
  const meta = JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: "injected caveat" },
  });
  assert.equal(parseTranscriptLine(meta, NONE).chunks.length, 0);

  const slash = JSON.stringify({
    type: "user",
    message: { role: "user", content: "<command-name>/clear</command-name>" },
  });
  assert.equal(parseTranscriptLine(slash, NONE).chunks.length, 0);
});

test("assistant line maps text, tool_use, and usage", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.ts" } },
      ],
      usage: { input_tokens: 90, cache_read_input_tokens: 10, output_tokens: 5 },
    },
  });
  const { chunks } = parseTranscriptLine(line, NONE);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { kind: "assistant_text", text: "Let me look." });
  assert.equal(chunks[1].kind, "tool_call");
  assert.deepEqual(JSON.parse(chunks[1].text), {
    toolName: "Read",
    toolCallId: "tu_1",
    input: { path: "a.ts" },
  });
  assert.equal(chunks[2].kind, "token_usage");
  // Anthropic cache buckets are ADDITIVE: 90 + 10 input, + 5 output.
  assert.equal(JSON.parse(chunks[2].text).contextTokens, 105);
});

test("TodoWrite becomes todo_update and suppresses its tool_result", () => {
  const call = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_todo",
          name: "TodoWrite",
          input: { todos: [{ content: "step 1", status: "in_progress" }] },
        },
      ],
    },
  });
  const parsed = parseTranscriptLine(call, NONE);
  assert.equal(parsed.chunks.length, 1);
  assert.equal(parsed.chunks[0].kind, "todo_update");
  assert.deepEqual(parsed.suppressToolIds, ["tu_todo"]);

  const result = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_todo", content: "Todos modified" },
      ],
    },
  });
  const suppressed = new Set(parsed.suppressToolIds);
  assert.equal(parseTranscriptLine(result, suppressed).chunks.length, 0);
});

test("tool_result lines map with error marker and text extraction", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_2",
          is_error: true,
          content: [{ type: "text", text: "no such file" }],
        },
      ],
    },
  });
  const { chunks } = parseTranscriptLine(line, NONE);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, "tool_result");
  const payload = JSON.parse(chunks[0].text) as {
    toolCallId: string;
    output: string;
  };
  assert.equal(payload.toolCallId, "tu_2");
  assert.match(payload.output, /^\[Error\] no such file/);
});

test("garbage, blank, and unknown-type lines produce nothing", () => {
  assert.equal(parseTranscriptLine("", NONE).chunks.length, 0);
  assert.equal(parseTranscriptLine("not json{", NONE).chunks.length, 0);
  assert.equal(
    parseTranscriptLine(JSON.stringify({ type: "summary", summary: "x" }), NONE)
      .chunks.length,
    0,
  );
});

test("LineBuffer only releases complete lines", () => {
  const buf = new LineBuffer();
  assert.deepEqual(buf.push('{"a":'), []);
  assert.deepEqual(buf.push('1}\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(buf.push(":3}\n"), ['{"c":3}']);
});

test("relay lines parse the fields we consume", () => {
  const relay = parseRelayLine(
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "abc",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
    }),
  );
  assert.deepEqual(relay, {
    hookEventName: "SessionStart",
    sessionId: "abc",
    transcriptPath: "/tmp/t.jsonl",
    cwd: "/repo",
  });
  assert.equal(parseRelayLine("junk"), null);
  assert.equal(parseRelayLine(JSON.stringify({ foo: 1 })), null);
});

test("hook settings wire every relay event to the relay file", () => {
  const json = buildHookSettings("/tmp/relay dir/relay.jsonl");
  const parsed = JSON.parse(json) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
    const cmd = parsed.hooks[event]?.[0]?.hooks?.[0]?.command;
    assert.ok(cmd, `${event} hook missing`);
    assert.match(cmd, /cat >> "\/tmp\/relay dir\/relay\.jsonl"/);
  }
  assert.throws(() => buildHookSettings('/bad/"quoted"/relay.jsonl'));
});

test("project path munge replaces every non-alphanumeric with dash", () => {
  assert.equal(
    mungeProjectPath("/Users/jo.e/My Repo_v2"),
    "-Users-jo-e-My-Repo-v2",
  );
  assert.equal(
    fallbackTranscriptPath("/Users/jo", "/Users/jo/proj", "sess-1"),
    "/Users/jo/.claude/projects/-Users-jo-proj/sess-1.jsonl",
  );
});
