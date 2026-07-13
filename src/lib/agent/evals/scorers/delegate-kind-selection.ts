// Scores whether the orchestrator delegated in a KIND-appropriate way:
// the right family of worker for the task (sealed coding agent vs general
// model) and, for general delegates, a per-spawn persona in the `role`
// field. Reads its expectation from the row's `expected` so one scenario
// can carry a coding row and a teaching row with different bars.
//
// Inspects the `delegate_task` tool inputs the orchestrator emitted — it
// measures the model's *choice*, independent of whether the (mock) spawn
// then succeeded.

import type { AgentTurnOutput, Scorer } from "../types.js";

export interface DelegateKindExpectation {
  /** Minimum number of delegate_task calls required. Default 1. */
  minCalls?: number;
  /** Every delegate_task call must carry a non-empty `role` (a persona) —
   *  the signature of a general-model delegation. */
  everyCallHasRole?: boolean;
  /** Each delegate_task call's `harness` field must name one of these
   *  delegates — used to assert the orchestrator picked the right kind.
   *  Include the sentinel `"(default)"` to also accept a call that omitted
   *  `harness` (relying on the configured default) — appropriate on rows
   *  where the default delegate is the right kind. */
  harnessNameOneOf?: string[];
}

function hasRole(input: Record<string, unknown>): boolean {
  return typeof input.role === "string" && input.role.trim().length > 0;
}

/** The `harness` a call named, or the `"(default)"` sentinel when omitted. */
function harnessToken(input: Record<string, unknown>): string {
  return typeof input.harness === "string" && input.harness.trim()
    ? input.harness
    : "(default)";
}

export function delegateKindSelection<TInput>(): Scorer<
  TInput,
  AgentTurnOutput,
  DelegateKindExpectation
> {
  return ({ output, expected }) => {
    const calls = output.steps.filter((s) => s.toolName === "delegate_task");
    const inputs = calls.map(
      (s) => (s.input ?? {}) as Record<string, unknown>,
    );
    const problems: string[] = [];

    const minCalls = expected.minCalls ?? 1;
    if (calls.length < minCalls) {
      problems.push(
        `expected >= ${minCalls} delegate_task call(s), saw ${calls.length}`,
      );
    }

    if (expected.everyCallHasRole) {
      const missing = inputs.filter((i) => !hasRole(i)).length;
      if (calls.length === 0 || missing > 0) {
        problems.push(
          `every delegate_task must set a non-empty role; ${missing}/${calls.length} missing`,
        );
      }
    }

    if (expected.harnessNameOneOf) {
      const allowed = new Set(expected.harnessNameOneOf);
      const offTarget = inputs.filter(
        (i) => !allowed.has(harnessToken(i)),
      ).length;
      if (calls.length === 0 || offTarget > 0) {
        problems.push(
          `each delegate_task harness must be one of [${expected.harnessNameOneOf.join(", ")}]; ${offTarget}/${calls.length} off-target`,
        );
      }
    }

    return {
      name: "delegate-kind-selection",
      score: problems.length === 0 ? 1 : 0,
      metadata: {
        problems,
        harnesses: inputs.map(harnessToken),
        roles: inputs.map((i) => (hasRole(i) ? "set" : "—")),
      },
    };
  };
}
