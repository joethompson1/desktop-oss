-- adapter_session_id: opaque session token that some adapters (notably the
-- claude-code-sdk adapter) emit on the first turn and accept as a
-- `resume` option on subsequent turns. Storing it on the run lets
-- continueRun / streamDelegateContinue restore full provider-side session
-- state (tool scratchpad, file checkpointing, conversation memory) on
-- follow-up turns, instead of replaying the message history into a
-- cold session each time.
--
-- Adapters that don't support session resume simply leave this NULL.

ALTER TABLE runs ADD COLUMN adapter_session_id TEXT;
