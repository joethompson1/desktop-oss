// Catches the orchestrator's "narrate the delegation instead of calling
// the tool" failure mode (the one that prompted this whole harness). A
// synthetic conversation primes the model to delegate: the prior
// assistant turn promised to spin up a sub-agent and asked for
// confirmation; the new user turn says "yes please". The orchestrator
// must respond by emitting a real `delegate_task` tool call — anything
// else (text describing the launch, "(No response generated)", calling
// the wrong tool) is a regression.
//
// Run:
//   ANTHROPIC_API_KEY=sk-ant-... \
//     npm run evals:one src/lib/agent/evals/scenarios/narrates-instead-of-calls.eval.ts
//
// Tunables (env vars):
//   ITERATIONS    how many times to replay (default 3 — the bug is
//                 intermittent, so one iteration is not enough).
//   EVAL_PROVIDER / EVAL_MODEL    see fixtures/eval-orchestrator-model.ts

import { installEvalMocks } from "../setup.js";
installEvalMocks();

import { mustCallTools } from "../scorers/must-call-tools.js";
import { noToolNarration } from "../scorers/no-tool-narration.js";
import { noEmptyResponse } from "../scorers/no-empty-response.js";
import type {
  AgentTurnExpected,
  AgentTurnOutput,
} from "../types.js";

const { runEvalLocally } = await import("../runner.js");
const { evalAgentTurn } = await import("../eval-agent-turn.js");
const { seedConversation, delegationFollowthroughTurns } = await import(
  "../fixtures/conversation-builder.js"
);
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
    "[narrates-instead-of-calls] skipping — set ANTHROPIC_API_KEY or EVAL_PROVIDER=openai-compatible to run.",
  );
} else {
  await runScenario();
}

async function runScenario(): Promise<void> {
  const iterations = process.env.ITERATIONS
    ? Math.max(1, Number.parseInt(process.env.ITERATIONS, 10) || 3)
    : 3;

  const { model, isAnthropic, provider, modelId } =
    buildEvalOrchestratorModel();
  const { harness: mockDelegate, calls: delegateCalls } =
    makeMockDelegateHarness({
      id: "eval-delegate",
      name: "EvalDelegate",
      reply:
        "Done. I implemented the requested change to lru.ts and added a smoke test.",
      filesChanged: ["lru.ts", "lru.test.ts"],
    });

  // eslint-disable-next-line no-console
  console.log(
    `[narrates-instead-of-calls] provider=${provider} model=${modelId} iterations=${iterations}`,
  );

  runEvalLocally<string, AgentTurnOutput, AgentTurnExpected>({
    name: `narrates-instead-of-calls (${provider}/${modelId})`,
    iterations,
    beforeEach: async () => {
      resetEvalDatabase();
      delegateCalls.length = 0;
      const conversationId = await ensureOrchestratorConversation();
      await seedConversation({
        conversationId,
        turns: delegationFollowthroughTurns({
          taskDescription:
            "Spin up a delegate to implement an LRU cache in a fresh TypeScript module, with a basic smoke test. Keep it small and focused.",
          delegateName: "EvalDelegate",
        }),
      });
    },
    data: () => [
      {
        input: "Yes please, go ahead.",
        expected: {
          mustCallTools: ["delegate_task"],
          mustNotNarrate: true,
          mustNotEmitPlaceholder: true,
        },
      },
    ],
    task: async (message) => {
      return evalAgentTurn({
        message,
        orchestratorModel: model,
        isAnthropic,
        resolveDelegateHarness: () => mockDelegate,
        delegateRosterConfigs: [mockDelegate.config],
      });
    },
    scores: [
      mustCallTools(["delegate_task"], "unordered"),
      noToolNarration(),
      noEmptyResponse(),
    ],
  });
}
