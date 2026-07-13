// Unit tests for the delegate-prompt composition rules. Cheap — no DB, no
// LLM, no Tauri runtime (the point of keeping these functions in a module
// that imports nothing heavy).
//
// Run via:
//   npm run test:unit
//   tsx --test src/lib/agent/delegate-prompt.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { harnessKind } from "$lib/types/harness";
import {
  DELEGATE_ROLE_FOOTER,
  buildDelegateBrief,
  composeDelegateSystemPrompt,
} from "./delegate-prompt.js";

const DEFAULT_BASE = "You are a specialist coding sub-agent.";
const ROLE = "You are a patient guitar tutor. Explain one concept at a time.";

describe("harnessKind", () => {
  it("maps raw-LLM harnesses to general", () => {
    assert.equal(harnessKind("anthropic"), "general");
    assert.equal(harnessKind("openai-compatible"), "general");
  });

  it("maps agentic harnesses to sealed", () => {
    assert.equal(harnessKind("claude-code"), "sealed");
    assert.equal(harnessKind("codex"), "sealed");
    assert.equal(harnessKind("cursor"), "sealed");
  });
});

describe("composeDelegateSystemPrompt", () => {
  it("returns the base unchanged when no role is set", () => {
    assert.equal(
      composeDelegateSystemPrompt(DEFAULT_BASE, undefined, "general", DEFAULT_BASE),
      DEFAULT_BASE,
    );
    assert.equal(
      composeDelegateSystemPrompt(DEFAULT_BASE, "   ", "general", DEFAULT_BASE),
      DEFAULT_BASE,
    );
  });

  it("returns the base unchanged for a sealed delegate even with a role", () => {
    // Sealed agents can't be reprogrammed via the system prompt; the role is
    // folded into the brief instead (see buildDelegateBrief).
    assert.equal(
      composeDelegateSystemPrompt(DEFAULT_BASE, ROLE, "sealed", DEFAULT_BASE),
      DEFAULT_BASE,
    );
  });

  it("makes the role the identity for a general delegate, dropping the stock default", () => {
    const out = composeDelegateSystemPrompt(DEFAULT_BASE, ROLE, "general", DEFAULT_BASE);
    assert.ok(out.startsWith(ROLE), "role should lead the system prompt");
    assert.ok(out.includes(DELEGATE_ROLE_FOOTER), "hygiene footer should be present");
    assert.ok(
      !out.includes(DEFAULT_BASE),
      "the stock coding-flavoured default should be dropped, not shown to a persona",
    );
  });

  it("preserves a user-customized base beneath the persona", () => {
    // The base a user edited in Settings may carry org policy / safety
    // constraints that must survive regardless of the persona.
    const customBase = `${DEFAULT_BASE}\nPolicy: never output customer PII.`;
    const out = composeDelegateSystemPrompt(customBase, ROLE, "general", DEFAULT_BASE);
    assert.ok(out.startsWith(ROLE), "role should still lead");
    assert.ok(
      out.includes("never output customer PII"),
      "user-customized base must be preserved",
    );
    assert.ok(out.includes(DELEGATE_ROLE_FOOTER));
  });
});

describe("buildDelegateBrief", () => {
  it("folds the role into a sealed delegate's brief", () => {
    const brief = buildDelegateBrief({ task: "Refactor lru.ts", role: ROLE }, "sealed");
    assert.ok(brief.includes("# Role"), "sealed brief should carry a # Role section");
    assert.ok(brief.includes(ROLE));
    assert.ok(brief.includes("# Task"));
  });

  it("omits the role from a general delegate's brief", () => {
    // General delegates carry the role in the system prompt; duplicating it in
    // the brief would be redundant.
    const brief = buildDelegateBrief({ task: "Teach recursion", role: ROLE }, "general");
    assert.ok(!brief.includes("# Role"), "general brief must not carry a # Role section");
    assert.ok(!brief.includes(ROLE));
    assert.ok(brief.includes("# Task"));
  });

  it("includes optional sections when provided", () => {
    const brief = buildDelegateBrief(
      {
        task: "Do the thing",
        context: "Be careful",
        workingDirectory: "/tmp/work",
        filesOfInterest: ["/tmp/work/a.ts"],
      },
      "general",
    );
    assert.ok(brief.includes("# Working directory"));
    assert.ok(brief.includes("/tmp/work"));
    assert.ok(brief.includes("# Context"));
    assert.ok(brief.includes("# Files of interest"));
    assert.ok(brief.includes("/tmp/work/a.ts"));
  });
});
