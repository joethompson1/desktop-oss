-- Each conversation becomes a "session" rooted in a working directory.
--
-- working_directory: absolute path the orchestrator (and the delegates it
--                    spawns) treat as the base for filesystem work. Injected
--                    into the orchestrator system prompt's Environment block
--                    and into delegate briefs. NULL for the legacy singleton
--                    conversation until backfilled to the user's home dir on
--                    first launch (see ensureDefaultSession in
--                    src/lib/db/conversations.ts).

ALTER TABLE conversations ADD COLUMN working_directory TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at);
