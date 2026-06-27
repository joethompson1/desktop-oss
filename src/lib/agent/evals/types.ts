// Wire shapes for the eval harness. Modelled on Clive backend's
// `apps/backend/src/agent/evals/types.ts` so scorers and runners port
// cleanly between the two projects.

import type { ToolSet } from "ai";
import type { ChatStreamPart } from "$lib/types/chat";

/**
 * One slice of stream output collapsed into a discrete tool-call step.
 * Each entry corresponds to one `tool-input-end` event observed on the
 * orchestrator's stream, paired with any `tool-output-*` event that
 * followed it.
 */
export interface StepResult {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
}

/**
 * The collapsed shape of a single orchestrator turn — what scorers see.
 *
 * `reply` is the assistant's final text content. `steps` is every tool
 * call the orchestrator emitted during the turn. `toolCallSequence` is
 * the flat ordered list of tool names — most scorers only care about
 * names + order, not full inputs.
 *
 * `rawStream` is kept for scorers that need to inspect text streaming
 * order vs tool-call timing (e.g. catching "narration before tool call"
 * patterns). It's the raw event log, not the rendered UI shape.
 */
export interface AgentTurnOutput {
  reply: string;
  steps: StepResult[];
  toolCallSequence: string[];
  toolCallCount: number;
  rawStream: ChatStreamPart[];
  /** Stream-level errors emitted by the SDK (e.g. provider timeouts /
   *  retries exhausted). Tool-level errors live on `StepResult.errorText`. */
  streamErrors: string[];
}

/**
 * What a scenario asserts about a turn's output. Optional fields let a
 * scorer decide whether they apply.
 */
export interface AgentTurnExpected {
  /** Tool names the orchestrator must call this turn. */
  mustCallTools?: string[];
  /** Whether `mustCallTools` requires order. Default is "unordered". */
  toolCallOrder?: "ordered" | "unordered";
  /** When true, fail the row if the reply contains narration patterns
   *  (e.g. "spawning the delegate now") with no actual tool call. */
  mustNotNarrate?: boolean;
  /** When true, fail the row if the reply is empty or matches the
   *  "(No response generated)" placeholder. */
  mustNotEmitPlaceholder?: boolean;
}

export interface ScorerResult {
  name: string;
  /** 0..1. Scenarios pass when every scorer hits `passingScore` (default 1). */
  score: number;
  /** Optional structured detail surfaced in failure messages. */
  metadata?: Record<string, unknown>;
}

export type Scorer<TInput, TOutput, TExpected> = (args: {
  input: TInput;
  output: TOutput;
  expected: TExpected;
}) => ScorerResult | Promise<ScorerResult>;

export interface DatasetRow<TInput, TExpected> {
  input: TInput;
  expected: TExpected;
  metadata?: Record<string, unknown>;
}

export interface EvalScenario<TInput, TOutput, TExpected> {
  name: string;
  /** Minimum score per scorer for a row to pass. Default `1.0`. */
  passingScore?: number;
  /** Per-row timeout. Default 180_000 (3 min). */
  timeoutMs?: number;
  /** Number of times to replay each row — useful for intermittent regressions. */
  iterations?: number;
  /** Called before each (row × iteration). Use to reset DB / seed fixture. */
  beforeEach?: () => Promise<void>;
  data: () =>
    | DatasetRow<TInput, TExpected>[]
    | Promise<DatasetRow<TInput, TExpected>[]>;
  task: (input: TInput) => Promise<TOutput>;
  scores: Scorer<TInput, TOutput, TExpected>[];
}

/**
 * Tool-set passed to the orchestrator for an eval. Mirrors the production
 * split (essential vs connector) so deferred-loading code paths exercise
 * if the scenario sets `connector` tools.
 */
export interface EvalToolset {
  essential: ToolSet;
  connector?: ToolSet;
}
