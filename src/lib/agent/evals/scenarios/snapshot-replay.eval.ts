// Parameterised replay scenario. Picks a captured snapshot fixture by
// name (via the SNAPSHOT env var), seeds the orchestrator DB with its
// captured messages / runs / chunks / prompt overrides, and replays a
// chosen prompt against the live model. Scores the same way as
// `narrates-instead-of-calls.eval.ts`.
//
// Usage:
//
//   ANTHROPIC_API_KEY=sk-ant-... \
//     SNAPSHOT=<slug-from-capture-cli> \
//     EXPECTED_TOOLS=delegate_task \
//     [PROMPT="message to send"] \
//     [ITERATIONS=3] \
//     npm run evals:one src/lib/agent/evals/scenarios/snapshot-replay.eval.ts
//
// What `PROMPT` does:
//   - If set, it's sent as a new user message after the snapshot is
//     seeded. Use this when you captured with `--before <ts>` so the
//     seeded history ends before the user's last message.
//   - If empty/unset, no new message is sent — the orchestrator responds
//     to the *last* message in the seeded history (typically the user's
//     final turn).

import { installEvalMocks } from "../setup.js";
installEvalMocks();

import { mustCallTools } from "../scorers/must-call-tools.js";
import { noToolNarration } from "../scorers/no-tool-narration.js";
import { noEmptyResponse } from "../scorers/no-empty-response.js";
import type {
  AgentTurnExpected,
  AgentTurnOutput,
} from "../types.js";
import type { RecordedDelegateResponse } from "../snapshot/types.js";

const { runEvalLocally } = await import("../runner.js");
const { evalAgentTurn } = await import("../eval-agent-turn.js");
const { makeMockDelegateAdapter } = await import(
  "../fixtures/mock-delegate-adapter.js"
);
const { buildEvalOrchestratorModel } = await import(
  "../fixtures/eval-orchestrator-model.js"
);
const { resetEvalDatabase } = await import("../setup.js");
const { ensureOrchestratorConversation } = await import(
  "$lib/db/conversations"
);
const { stableHash } = await import("../snapshot/capture.js");

const snapshotName = process.env.SNAPSHOT;
const expectedToolsRaw = process.env.EXPECTED_TOOLS;

if (!snapshotName || !expectedToolsRaw) {
  // eslint-disable-next-line no-console
  console.log(
    "[snapshot-replay] skipping — set SNAPSHOT and EXPECTED_TOOLS to run this template.",
  );
} else if (!process.env.ANTHROPIC_API_KEY && process.env.EVAL_PROVIDER !== "openai-compatible") {
  // eslint-disable-next-line no-console
  console.log(
    "[snapshot-replay] skipping — set ANTHROPIC_API_KEY or EVAL_PROVIDER=openai-compatible to run.",
  );
} else {
  if (!/^[a-z0-9-]+$/.test(snapshotName)) {
    throw new Error(
      `Invalid SNAPSHOT value ${JSON.stringify(snapshotName)} — must match /^[a-z0-9-]+$/.`,
    );
  }
  const expectedTools = expectedToolsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (expectedTools.length === 0) {
    throw new Error(
      `EXPECTED_TOOLS must contain at least one tool name (got ${JSON.stringify(expectedToolsRaw)}).`,
    );
  }
  await runReplay(snapshotName, expectedTools);
}

async function runReplay(
  snapshotName: string,
  expectedTools: string[],
): Promise<void> {
  const snapshotModule = (await import(
    `../fixtures/snapshots/${snapshotName}.js`
  )) as {
    buildSnapshotConversation: (conversationId: string) => Promise<void>;
    snapshotRecordedResponses: Record<string, RecordedDelegateResponse>;
    snapshotAdapterConfigs: import("$lib/types/adapter").AdapterConfig[];
    snapshotMetadata: { capturedAt: string; conversationId: string };
  };

  const iterations = process.env.ITERATIONS
    ? Math.max(1, Number.parseInt(process.env.ITERATIONS, 10) || 1)
    : 1;
  const prompt = process.env.PROMPT ?? "";
  const { model, isAnthropic, provider, modelId } =
    buildEvalOrchestratorModel();

  const { adapter: mockDelegate } = makeMockDelegateAdapter({
    id: "snapshot-delegate",
    name: "SnapshotDelegate",
  });
  // Reach into the mock to swap its scripted reply per call based on
  // input. Cleaner than a one-shot constructor option since each
  // `delegate_task` from the orchestrator may have a different brief.
  const origStream = mockDelegate.streamChat.bind(mockDelegate);
  mockDelegate.streamChat = (params) => {
    const userTurn = params.messages.findLast?.((m) => m.role === "user");
    const brief = (userTurn?.content as string) ?? "";
    const key = stableHash(brief);
    const recorded = snapshotModule.snapshotRecordedResponses[key];
    if (recorded) {
      // Re-create the scripted adapter with the recorded reply baked in.
      const { adapter } = makeMockDelegateAdapter({
        id: "snapshot-delegate",
        name: "SnapshotDelegate",
        reply: recorded.reply,
        filesChanged: recorded.filesChanged,
      });
      return adapter.streamChat(params);
    }
    return origStream(params);
  };

  // eslint-disable-next-line no-console
  console.log(
    `[snapshot-replay] snapshot=${snapshotName} provider=${provider} model=${modelId} iterations=${iterations} prompt=${JSON.stringify(prompt)} expected=${JSON.stringify(expectedTools)}`,
  );

  runEvalLocally<string, AgentTurnOutput, AgentTurnExpected>({
    name: `snapshot-replay (${snapshotName} → ${provider}/${modelId})`,
    iterations,
    beforeEach: async () => {
      resetEvalDatabase();
      const conversationId = await ensureOrchestratorConversation();
      await snapshotModule.buildSnapshotConversation(conversationId);
    },
    data: () => [
      {
        input: prompt,
        expected: {
          mustCallTools: expectedTools,
          toolCallOrder: "unordered",
          mustNotNarrate: true,
          mustNotEmitPlaceholder: true,
        },
      },
    ],
    task: async (message) => {
      // Empty PROMPT means "let the model respond to whatever the seeded
      // history ends with". streamOrchestratorTurn requires a user
      // message though; pass an empty string and the model will treat
      // the last seeded user turn as the prompt.
      return evalAgentTurn({
        message: message || "",
        orchestratorModel: model,
        isAnthropic,
        resolveDelegateAdapter: () => mockDelegate,
        delegateRosterConfigs: snapshotModule.snapshotAdapterConfigs,
      });
    },
    scores: [
      mustCallTools(expectedTools, "unordered"),
      noToolNarration(),
      noEmptyResponse(),
    ],
  });
}
