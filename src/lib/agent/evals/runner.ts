// Lightweight test-runner wrapper. Registers one `describe` / `it` block
// per scenario; inside, iterates the (row × iteration) matrix and reports
// scorer failures with structured detail.
//
// Modelled on Clive backend's `apps/backend/src/agent/evals/runner.ts`.

import { describe, it } from "node:test";

import type {
  AgentTurnOutput,
  EvalScenario,
  ScorerResult,
} from "./types.js";

interface ScenarioRunReport {
  rowIndex: number;
  iteration: number;
  passed: boolean;
  scores: ScorerResult[];
  durationMs: number;
  error?: Error;
  output?: AgentTurnOutput;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_PASSING_SCORE = 1.0;
const DEFAULT_ITERATIONS = 1;

export function runEvalLocally<TInput, TOutput, TExpected>(
  scenario: EvalScenario<TInput, TOutput, TExpected>,
): void {
  const iterations = scenario.iterations ?? DEFAULT_ITERATIONS;
  const passingScore = scenario.passingScore ?? DEFAULT_PASSING_SCORE;
  const timeoutMs = scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  describe(scenario.name, () => {
    it(
      scenario.name,
      { timeout: timeoutMs * iterations + 10_000 },
      async () => {
        const rows = await scenario.data();
        const reports: ScenarioRunReport[] = [];

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const row = rows[rowIndex];
          for (let iter = 0; iter < iterations; iter++) {
            if (scenario.beforeEach) {
              await scenario.beforeEach();
            }
            const startedAt = performance.now();
            let output: TOutput | undefined;
            let error: Error | undefined;
            const scores: ScorerResult[] = [];
            try {
              output = await scenario.task(row.input);
              for (const scorer of scenario.scores) {
                const result = await scorer({
                  input: row.input,
                  output,
                  expected: row.expected,
                });
                scores.push(result);
              }
            } catch (err) {
              error = err instanceof Error ? err : new Error(String(err));
            }
            const durationMs = performance.now() - startedAt;
            const passed =
              !error &&
              scores.length > 0 &&
              scores.every((s) => s.score >= passingScore);

            reports.push({
              rowIndex,
              iteration: iter,
              passed,
              scores,
              durationMs,
              error,
              output: output as AgentTurnOutput | undefined,
            });
          }
        }

        const failures = reports.filter((r) => !r.passed);
        if (failures.length > 0) {
          const lines: string[] = [];
          lines.push(
            `${failures.length}/${reports.length} (row × iteration) failed for scenario "${scenario.name}":`,
          );
          for (const f of failures) {
            const header = `  row=${f.rowIndex} iter=${f.iteration} duration=${Math.round(f.durationMs)}ms`;
            if (f.error) {
              lines.push(`${header} — threw: ${f.error.message}`);
              continue;
            }
            const summary = f.scores
              .map((s) => `${s.name}=${s.score.toFixed(2)}`)
              .join(" ");
            lines.push(`${header} — scores: ${summary}`);
            for (const s of f.scores) {
              if (s.score < passingScore && s.metadata) {
                lines.push(
                  `    ${s.name} detail: ${JSON.stringify(s.metadata)}`,
                );
              }
            }
            if (f.output) {
              const replyPreview = (f.output.reply ?? "").slice(0, 240);
              lines.push(`    reply: ${JSON.stringify(replyPreview)}`);
              lines.push(
                `    toolCalls: [${f.output.toolCallSequence.join(", ")}]`,
              );
              if (f.output.streamErrors && f.output.streamErrors.length > 0) {
                lines.push(
                  `    streamErrors: ${JSON.stringify(f.output.streamErrors)}`,
                );
              }
            }
          }
          throw new Error(lines.join("\n"));
        }
      },
    );
  });
}
