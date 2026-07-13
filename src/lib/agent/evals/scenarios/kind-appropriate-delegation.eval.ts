// Demonstrates kind-appropriate delegation: the orchestrator routes work to
// the right family of worker. Two harnesses are on the roster — a sealed
// coding agent ("CodeAgent") and a general model ("Tutor"). Two rows exercise
// the two directions:
//
//   - a code-refactor task must go to the sealed coding agent;
//   - a "teach me across two lessons" task must spawn general-model
//     delegates, each carrying a distinct tutor persona in the `role` field.
//
// This is the "demonstrated, not asserted" acceptance check for kinds +
// per-spawn personas. Anything else (delegating code to the general model,
// spawning a tutor with no role) is a regression.
//
// Run:
//   ANTHROPIC_API_KEY=sk-ant-... \
//     npm run evals:one src/lib/agent/evals/scenarios/kind-appropriate-delegation.eval.ts
//
// Tunables (env vars):
//   ITERATIONS    how many times to replay each row (default 2).
//   EVAL_PROVIDER / EVAL_MODEL    see fixtures/eval-orchestrator-model.ts

import { installEvalMocks } from "../setup.js";
installEvalMocks();

import { delegateKindSelection } from "../scorers/delegate-kind-selection.js";
import type { DelegateKindExpectation } from "../scorers/delegate-kind-selection.js";
import type { AgentTurnOutput } from "../types.js";
import type { LLMHarness } from "$lib/types/harness";

const { runEvalLocally } = await import("../runner.js");
const { evalAgentTurn } = await import("../eval-agent-turn.js");
const { makeMockDelegateHarness } = await import(
  "../fixtures/mock-delegate-harness.js"
);
const { buildEvalOrchestratorModel } = await import(
  "../fixtures/eval-orchestrator-model.js"
);
const { resetEvalDatabase } = await import("../setup.js");
const { ensureOrchestratorConversation } = await import(
  "$lib/db/conversations"
);

if (!process.env.ANTHROPIC_API_KEY && process.env.EVAL_PROVIDER !== "openai-compatible") {
  // eslint-disable-next-line no-console
  console.log(
    "[kind-appropriate-delegation] skipping — set ANTHROPIC_API_KEY or EVAL_PROVIDER=openai-compatible to run.",
  );
} else {
  await runScenario();
}

async function runScenario(): Promise<void> {
  const iterations = process.env.ITERATIONS
    ? Math.max(1, Number.parseInt(process.env.ITERATIONS, 10) || 2)
    : 2;

  const { model, isAnthropic, provider, modelId } =
    buildEvalOrchestratorModel();

  const { harness: codeAgent } = makeMockDelegateHarness({
    id: "code-agent",
    name: "CodeAgent",
    type: "claude-code",
    description:
      "Coding agent for editing files and running commands in this workspace.",
    reply: "Done. Refactored the cache and kept the public API stable.",
    filesChanged: ["src/lru.ts"],
  });
  const { harness: tutor } = makeMockDelegateHarness({
    id: "tutor",
    name: "Tutor",
    type: "openai-compatible",
    description:
      "General model with no built-in tools — give it a role to make it a tutor, researcher, critic, etc.",
    reply: "Understood — I'll teach this in my assigned persona.",
  });

  // Map the orchestrator's `harness` pick to the matching mock. An omitted
  // name falls back to the general Tutor so a spawn always succeeds — the
  // scorer separately checks the model named the right delegate.
  const resolveDelegateHarness = (preferredName?: string): LLMHarness | null => {
    if (preferredName === "CodeAgent") return codeAgent;
    if (preferredName === "Tutor") return tutor;
    return tutor;
  };

  // eslint-disable-next-line no-console
  console.log(
    `[kind-appropriate-delegation] provider=${provider} model=${modelId} iterations=${iterations}`,
  );

  runEvalLocally<string, AgentTurnOutput, DelegateKindExpectation>({
    name: `kind-appropriate-delegation (${provider}/${modelId})`,
    iterations,
    beforeEach: async () => {
      resetEvalDatabase();
      await ensureOrchestratorConversation();
    },
    data: () => [
      {
        input:
          "Refactor the LRU cache in src/lru.ts to use a Map instead of a plain " +
          "object, keeping the existing public API. Hand this to the right specialist.",
        expected: {
          minCalls: 1,
          harnessNameOneOf: ["CodeAgent"],
        },
      },
      {
        input:
          "I want to learn Python recursion from scratch. Set me up with two " +
          "dedicated tutors I can talk to separately: one for the fundamentals " +
          "(base cases and the call stack) and one for practical patterns " +
          "(recursion vs iteration, common pitfalls). Give each its own persona.",
        expected: {
          minCalls: 2,
          everyCallHasRole: true,
          // Accept an explicit "Tutor" OR an omitted harness (the resolver's
          // fallback is the general Tutor, so relying on the default is a
          // correct choice here — the persona in `role` is the real signal).
          harnessNameOneOf: ["Tutor", "(default)"],
        },
      },
    ],
    task: async (message) => {
      return evalAgentTurn({
        message,
        orchestratorModel: model,
        isAnthropic,
        resolveDelegateHarness,
        delegateRosterConfigs: [codeAgent.config, tutor.config],
      });
    },
    scores: [delegateKindSelection()],
  });
}
