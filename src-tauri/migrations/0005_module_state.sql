-- Generic per-conversation, per-module state store. Lets a module opt into
-- surviving reloads (AppModule.serializeState/hydrateState in
-- src/lib/modules/types.ts) without every module needing its own table.

CREATE TABLE IF NOT EXISTS module_state (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, module_id)
);
