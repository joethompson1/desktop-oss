-- Dual-surface delegates (GUI chat / TUI terminal — two views of one session).
--
-- surface: which surface the run is currently on: 'gui' (headless SDK driver,
--          chat view — the default when NULL) or 'tui' (the real agent CLI
--          running interactively in an embedded terminal). Mode is switchable
--          at turn boundaries; this column records the current one so the run
--          page reopens on the right view.
--
-- workdir: the run's real working directory, persisted at spawn. Previously
--          the workdir only appeared as text inside the task brief; dual
--          surfaces make it load-bearing — the SDK driver and the TUI CLI
--          must run in the SAME cwd or Claude Code cannot resume the shared
--          session (its on-disk session store is keyed by cwd).
--
-- tui_initial_prompt: for delegates SPAWNED into TUI mode, the task brief to
--          hand the CLI as its first prompt on the user's first launch of the
--          terminal (an interactive CLI can't be fed a turn headlessly). NULL
--          once consumed, and for GUI-spawned runs.

ALTER TABLE runs ADD COLUMN surface TEXT;
ALTER TABLE runs ADD COLUMN workdir TEXT;
ALTER TABLE runs ADD COLUMN tui_initial_prompt TEXT;
