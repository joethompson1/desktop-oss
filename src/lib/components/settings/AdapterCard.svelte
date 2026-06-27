<script lang="ts">
  // Shared adapter row — one card per configured adapter. Owns its own
  // per-row edit state (API key visibility, defaults-editor toggle, drafts)
  // and emits commits back to the parent via callback props. The parent
  // (`/settings/+page.svelte`) only handles the cross-adapter operations
  // (delete, mark-as-orchestrator, mark-as-delegate).
  //
  // Per-type rendering lives inside the card via conditional blocks rather
  // than per-type sub-components. The chrome (badge, name, role chips,
  // delete button, action buttons) is identical for every adapter and the
  // type-specific blocks (Anthropic auth radio, Codex profile+sandbox,
  // model dropdown) are short enough that splitting them across files
  // costs more in discoverability than it saves in line count.
  import {
    isDelegateOnlyType,
    type AdapterConfig,
    type AnthropicAuthMode,
  } from "$lib/types/adapter";
  import {
    CLAUDE_CODE_MODEL_PRESETS,
    CODEX_MODEL_PRESETS,
    CURSOR_MODEL_PRESETS,
    type ModelPreset,
  } from "$lib/adapters/presets";

  interface Props {
    cfg: AdapterConfig;
    accountInfo: { has: boolean; email: string | null } | null;
    onUpdate: (next: AdapterConfig) => void | Promise<void>;
    onDelete: () => void | Promise<void>;
    onSetOrchestrator: () => void | Promise<void>;
    onSetDelegate: () => void | Promise<void>;
    onRefreshAccount: () => void | Promise<void>;
    loadApiKey: () => Promise<string | null>;
    saveApiKey: (key: string) => Promise<void>;
    clearApiKey: () => Promise<void>;
  }

  let {
    cfg,
    accountInfo,
    onUpdate,
    onDelete,
    onSetOrchestrator,
    onSetDelegate,
    onRefreshAccount,
    loadApiKey,
    saveApiKey,
    clearApiKey,
  }: Props = $props();

  let editingKey = $state(false);
  let keyDraft = $state("");

  let editingDefaults = $state(false);
  let modelPresetIdx = $state(0);
  let modelCustomDraft = $state("");
  let profileDraft = $state("");
  let sandboxDraft = $state<
    "read-only" | "workspace-write" | "danger-full-access"
  >("danger-full-access");
  // Free-text "role / strengths" hint — flows into the orchestrator's
  // system prompt as the description for this delegate. Lets the user
  // tell the orchestrator what this adapter is best for in *their*
  // setup ("good at tests", "fast local model — use for mechanical
  // edits", etc.).
  let descriptionDraft = $state("");

  /** Which preset list — if any — is editable for this adapter's
   *  "default model" dropdown. Anthropic and openai-compatible use
   *  provider-tied dropdowns set on the new-adapter form; we don't
   *  re-render those here. The agentic adapters share one shape. */
  function presetsFor(type: AdapterConfig["type"]): ModelPreset[] {
    switch (type) {
      case "claude-code":
        return CLAUDE_CODE_MODEL_PRESETS;
      case "codex":
        return CODEX_MODEL_PRESETS;
      case "cursor":
        return CURSOR_MODEL_PRESETS;
      default:
        return [];
    }
  }

  const presetList = $derived<ModelPreset[]>(presetsFor(cfg.type));
  /** True when the adapter type exposes a default-model dropdown.
   *  Anthropic and OpenAI-compatible adapters bind their model at
   *  create time via provider/preset pickers in the new-adapter form;
   *  they don't get a post-create model editor here. */
  const showModelEditor = $derived(presetList.length > 0);
  // API key UI applies to any adapter that needs a user-supplied key.
  // Claude Code and Codex authenticate via their own native flows
  // (Claude Code keychain, codex login) — no key field on those.
  const showApiKeyUI = $derived(
    cfg.type === "openai-compatible" ||
      cfg.type === "cursor" ||
      (cfg.type === "anthropic" && cfg.authMode === "api-key"),
  );

  function defaultLabel(type: AdapterConfig["type"]): string {
    if (type === "codex") return "profile default";
    if (type === "claude-code") return "Claude Code default";
    if (type === "cursor") return "Cursor default";
    return "default";
  }

  function startEditDefaults() {
    profileDraft = cfg.codexProfile ?? "";
    sandboxDraft = cfg.codexSandbox ?? "danger-full-access";
    descriptionDraft = cfg.description ?? "";
    if (cfg.model) {
      const matched = presetList.findIndex((p) => p.model === cfg.model);
      modelPresetIdx = matched >= 0 ? matched : -1;
      modelCustomDraft = matched >= 0 ? "" : cfg.model;
    } else {
      modelPresetIdx = -2;
      modelCustomDraft = "";
    }
    editingDefaults = true;
  }

  function commitEditDefaults() {
    const model =
      modelPresetIdx >= 0
        ? presetList[modelPresetIdx]?.model
        : modelPresetIdx === -1
          ? modelCustomDraft.trim() || undefined
          : undefined;
    const trimmedDescription = descriptionDraft.trim();
    const next: AdapterConfig = {
      ...cfg,
      model,
      description: trimmedDescription || undefined,
    };
    if (cfg.type === "codex") {
      const p = profileDraft.trim();
      next.codexProfile = p || undefined;
      next.codexSandbox = sandboxDraft;
    }
    void onUpdate(next);
    editingDefaults = false;
  }

  function startKeyEdit() {
    editingKey = true;
    keyDraft = "";
    void loadApiKey().then((existing) => {
      keyDraft = existing ?? "";
    });
  }

  async function commitKey() {
    const draft = keyDraft.trim();
    if (!draft) await clearApiKey();
    else await saveApiKey(draft);
    editingKey = false;
  }
</script>

<div class="adapter">
  <div class="adapter-head">
    <div class="adapter-title">
      <span class="badge">{cfg.type}</span>
      <span class="name">{cfg.name}</span>
      {#if cfg.isOrchestratorDefault}
        <span class="role role-orchestrator">orchestrator</span>
      {/if}
      {#if cfg.isDelegateDefault}
        <span
          class="role role-default-delegate"
          title="The orchestrator routes here when it doesn't pick a specific delegate."
        >default delegate</span>
      {:else if !cfg.isOrchestratorDefault}
        <span
          class="role role-delegate-available"
          title="The orchestrator can route tasks here by name. Not the fallback default."
        >delegate</span>
      {/if}
    </div>
    <button class="danger" onclick={() => void onDelete()}>Delete</button>
  </div>

  {#if cfg.model || cfg.baseUrl || cfg.context1m}
    <div class="row">
      {#if cfg.model}
        <span class="kv">model: <code>{cfg.model}</code></span>
      {/if}
      {#if cfg.context1m}
        <span class="badge ctx">1M context</span>
      {/if}
      {#if cfg.baseUrl}
        <span class="kv">url: <code>{cfg.baseUrl}</code></span>
      {/if}
    </div>
  {/if}

  {#if editingDefaults}
    <div class="edit-block">
      {#if showModelEditor}
        <div class="row">
          <label class="kv field">
            default model
            <select bind:value={modelPresetIdx}>
              <option value={-2}>Use {defaultLabel(cfg.type)}</option>
              {#each presetList as preset, i (preset.label)}
                <option value={i}>
                  {preset.label}{preset.hint ? ` — ${preset.hint}` : ""}
                </option>
              {/each}
              <option value={-1}>Custom model ID…</option>
            </select>
          </label>
          {#if modelPresetIdx === -1}
            <label class="kv field">
              id
              <input
                type="text"
                placeholder="model id"
                bind:value={modelCustomDraft}
              />
            </label>
          {/if}
          {#if cfg.type === "codex"}
            <label class="kv field">
              profile
              <input
                type="text"
                placeholder="e.g. macstudio-qwen-coder"
                bind:value={profileDraft}
              />
            </label>
            <label class="kv field">
              sandbox
              <select bind:value={sandboxDraft}>
                <option value="danger-full-access">danger-full-access</option>
                <option value="workspace-write">workspace-write</option>
                <option value="read-only">read-only</option>
              </select>
            </label>
          {/if}
        </div>
      {/if}
      <label class="kv field full">
        role / strengths
        <textarea
          rows="3"
          placeholder="What is this adapter best at? The orchestrator reads this when picking a delegate."
          bind:value={descriptionDraft}
        ></textarea>
      </label>
      <div class="row">
        <button onclick={commitEditDefaults}>Save</button>
        <button onclick={() => (editingDefaults = false)}>Cancel</button>
      </div>
    </div>
  {:else}
    <div class="row">
      {#if showModelEditor}
        <span class="kv">
          default model:
          {#if cfg.model}
            <code>{cfg.model}</code>
          {:else}
            <em class="muted">{defaultLabel(cfg.type)}</em>
          {/if}
        </span>
        {#if cfg.type === "codex"}
          <span class="kv">
            profile:
            {#if cfg.codexProfile}
              <code>{cfg.codexProfile}</code>
            {:else}
              <em class="muted">codex default</em>
            {/if}
          </span>
          <span class="kv">
            sandbox:
            <code>{cfg.codexSandbox ?? "danger-full-access"}</code>
          </span>
        {/if}
      {/if}
      <button onclick={startEditDefaults}>
        {showModelEditor ? "Edit defaults" : "Edit description"}
      </button>
    </div>
    {#if cfg.description}
      <p class="role-hint">{cfg.description}</p>
    {/if}
  {/if}

  {#if cfg.type === "anthropic"}
    <div class="row">
      <label class="auth-mode">
        <input
          type="radio"
          name={`auth-${cfg.id}`}
          value="account"
          checked={cfg.authMode === "account"}
          onchange={() => void onUpdate({ ...cfg, authMode: "account" as AnthropicAuthMode })}
        />
        Account (Claude Code login)
      </label>
      <label class="auth-mode">
        <input
          type="radio"
          name={`auth-${cfg.id}`}
          value="api-key"
          checked={cfg.authMode === "api-key"}
          onchange={() => void onUpdate({ ...cfg, authMode: "api-key" as AnthropicAuthMode })}
        />
        API key
      </label>
    </div>

    {#if cfg.authMode === "account"}
      <div class="row account-row">
        {#if accountInfo?.has}
          <span class="ok">
            ✓ Logged in
            {#if accountInfo.email}as <code>{accountInfo.email}</code>{/if}
          </span>
        {:else}
          <span class="warn">
            No Claude Code login detected. Run
            <code>claude auth login</code> in a terminal, then click
            Re-check.
          </span>
        {/if}
        <button onclick={() => void onRefreshAccount()}>Re-check</button>
      </div>
    {/if}
  {/if}

  {#if showApiKeyUI}
    <div class="row">
      {#if editingKey}
        <input
          class="key"
          type="password"
          placeholder="API key"
          bind:value={keyDraft}
          autocomplete="off"
        />
        <button onclick={() => void commitKey()}>Save</button>
        <button onclick={() => (editingKey = false)}>Cancel</button>
      {:else}
        <button onclick={startKeyEdit}>Set / change API key</button>
      {/if}
    </div>
  {/if}

  <div class="row actions">
    {#if !cfg.isOrchestratorDefault && !isDelegateOnlyType(cfg.type)}
      <button onclick={() => void onSetOrchestrator()}>
        Set as orchestrator
      </button>
    {/if}
    {#if !cfg.isDelegateDefault && !cfg.isOrchestratorDefault}
      <button
        onclick={() => void onSetDelegate()}
        title="Sets this adapter as the orchestrator's fallback when it doesn't pick a specific delegate by name. Every adapter here is already available as a delegate the orchestrator can call by name."
      >Make default delegate</button>
    {/if}
  </div>
</div>

<style>
  .adapter {
    padding: 0.9em 1em;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 0.5em;
  }
  .adapter-head {
    display: flex;
    align-items: center;
    gap: 0.6em;
  }
  .adapter-title {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.6em;
    flex-wrap: wrap;
  }
  .badge {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 0.1em 0.5em;
    border-radius: 4px;
    font-size: 0.74em;
    color: var(--text-muted);
    text-transform: lowercase;
  }
  .badge.ctx {
    color: var(--accent-text);
    border-color: var(--accent);
    text-transform: none;
  }
  .name {
    font-weight: 600;
  }
  .role {
    font-size: 0.74em;
    padding: 0.1em 0.5em;
    border-radius: 4px;
    border: 1px solid transparent;
  }
  /* Active orchestrator — solid accent. Singular per app. */
  .role.role-orchestrator {
    color: var(--accent-text);
    background: var(--bg);
    border-color: var(--accent);
  }
  /* The fallback delegate the orchestrator picks when it doesn't
   * specify a name. Singular per app. */
  .role.role-default-delegate {
    color: var(--accent-text);
    background: var(--bg);
    border-color: var(--accent);
  }
  /* Other delegate-eligible adapters — orchestrator can route to them
   * by name. Subdued so the singular default reads as primary. */
  .role.role-delegate-available {
    color: var(--text-muted);
    background: transparent;
    border-color: var(--border);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6em;
    flex-wrap: wrap;
  }
  .row.actions {
    margin-top: 0.2em;
  }
  .kv {
    color: var(--text-muted);
    font-size: 0.86em;
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
  }
  .kv code {
    color: var(--text);
  }
  .kv.field {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2em;
  }
  .kv.field.full {
    width: 100%;
  }
  .kv.field.full textarea {
    width: 100%;
  }
  .edit-block {
    display: flex;
    flex-direction: column;
    gap: 0.5em;
    padding: 0.6em 0.7em;
    border: 1px dashed var(--border);
    border-radius: 6px;
    background: var(--bg);
  }
  .role-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.82em;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  textarea {
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text);
    padding: 0.4em 0.55em;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.86em;
    line-height: 1.45;
    resize: vertical;
    min-height: 4em;
  }
  .auth-mode {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    color: var(--text-muted);
    font-size: 0.88em;
  }
  .account-row .ok {
    color: var(--success);
  }
  .account-row .warn {
    color: var(--warn);
  }
  .muted {
    color: var(--text-faint);
    font-style: italic;
  }
  .key {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text);
    padding: 0.4em 0.6em;
    font-family: var(--code-mono);
    font-size: 0.86em;
    min-width: 220px;
  }
  input[type="text"],
  select {
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text);
    padding: 0.3em 0.5em;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.86em;
  }
  button {
    background: var(--bg);
    border: 1px solid var(--border-strong);
    color: var(--text);
    padding: 0.4em 0.8em;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85em;
  }
  button:hover {
    background: var(--hover-bg);
  }
  button.danger {
    color: var(--danger-text);
    border-color: var(--border);
  }
  button.danger:hover {
    background: var(--danger-bg);
  }
</style>
