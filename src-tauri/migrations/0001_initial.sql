-- Initial schema for clive-desktop-oss local store.
-- Conversations = orchestrator threads (typically one long-running thread).
-- Messages = the orchestrator's wire-shape UIChatTurn rows.
-- Runs = delegate sub-agent invocations, owned by a conversation.
-- Run chunks = streamed output rows from delegates (cockpit timeline).
-- Memories = scoped notes the orchestrator persists.
-- Settings = JSON blob key/value (adapter configs, prompts, etc).

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_message_id TEXT,
    tool_call_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    delegate_adapter_id TEXT,
    delegate_type TEXT,
    exit_code INTEGER,
    summary TEXT,
    files_changed_json TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_conversation_created
    ON runs(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status
    ON runs(status);

CREATE TABLE IF NOT EXISTS run_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_chunks_run_seq
    ON run_chunks(run_id, seq);

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'personal',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
