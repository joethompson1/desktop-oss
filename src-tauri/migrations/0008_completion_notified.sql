-- Persist whether the orchestrator has been told a delegate run finished.
--
-- completion_notified: 0/1 flag. Set to 1 the moment a completion notification
--          for this run is enqueued into the orchestrator chat (either the live
--          run-events bus while the session is mounted, or the hydrate sweep
--          that reconciles runs which finished while the session was unmounted /
--          across an app restart). This is the single guard against
--          double-notifying: because it is persisted, a delegate that finishes
--          on its own run page — with the session store unmounted and no live
--          listener — is still reconciled on the next session mount, and a run
--          already announced is never announced twice (remount, replay, or two
--          near-simultaneous completions batching together).
--
-- Backfill: existing terminal runs predate completion tracking, so mark them
--          already-notified — otherwise the first hydrate after this migration
--          would replay a burst of stale "[Background delegate update]"s for
--          every historical delegate. Runs still PENDING/RUNNING at upgrade time
--          are left at 0: markStaleRunsAbandoned cancels them on the next
--          hydrate, and the sweep then legitimately tells the orchestrator its
--          in-flight workers evaporated.

ALTER TABLE runs ADD COLUMN completion_notified INTEGER NOT NULL DEFAULT 0;

UPDATE runs SET completion_notified = 1
  WHERE status IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
