-- Adds delegate orchestration fields to the runs table.
--
-- name:            Optional label the orchestrator assigns when spawning a delegate
--                  (via delegate_task's new `name` field). Used by message_delegate
--                  and get_delegate_history to reference a run without knowing its ID.
--
-- context_summary: Rolling compressed summary of the run's older conversation turns.
--                  Regenerated after each delegate turn once the run exceeds the
--                  SUMMARY_THRESHOLD. Bounded context reconstruction in
--                  continueRun / streamDelegateContinue uses this instead of
--                  replaying the full chunk history, keeping adapter calls within
--                  a predictable token budget.

ALTER TABLE runs ADD COLUMN name TEXT;
ALTER TABLE runs ADD COLUMN context_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_conversation_name
    ON runs(conversation_id, name) WHERE name IS NOT NULL;
