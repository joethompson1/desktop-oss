-- Per-spawn delegate role / persona.
--
-- role: Free-text identity the orchestrator authors when spawning a delegate
--       (via delegate_task's `role` field), e.g. "You are a patient tutor
--       covering chapter 2 of X…". For general (raw-LLM) delegates this becomes
--       the delegate's system prompt; for sealed coding agents it is folded
--       into the task brief as best-effort framing. Persisted on the run so the
--       persona survives history replay, message_delegate continuations, and the
--       user chatting on the delegate's own page — the composition is re-derived
--       from this column on every turn rather than living only in the first
--       prompt. NULL for delegates spawned without a role (the default).

ALTER TABLE runs ADD COLUMN role TEXT;
