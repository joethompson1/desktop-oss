<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { adapters } from "$lib/stores/adapters.svelte";
  import { health } from "$lib/stores/health.svelte";
  import { conversations } from "$lib/stores/conversations.svelte";
  import { modules } from "$lib/modules/store.svelte";
  import {
    deleteConversation,
    listConversations,
  } from "$lib/db/conversations";
  import {
    getAdapterApiKey,
    setAdapterApiKey,
    clearAdapterApiKey,
  } from "$lib/adapters";
  import { readClaudeCodeCredentials } from "$lib/adapters/claude-code-auth";
  import {
    loadOrchestratorPrompt,
    loadDelegatePrompt,
    saveOrchestratorPrompt,
    saveDelegatePrompt,
    DEFAULT_ORCHESTRATOR_PROMPT,
    DEFAULT_DELEGATE_PROMPT,
  } from "$lib/agent/prompts";
  import {
    skills as skillsStore,
    refresh as refreshSkills,
    setSourceEnabled,
  } from "$lib/stores/skills.svelte";
  import {
    permissions as skillPermissions,
    revokeRule,
  } from "$lib/stores/skill-permissions.svelte";
  import { displayPrefix, sourceLabel } from "$lib/skills/display";
  import type { SkillSource } from "$lib/skills/types";
  import {
    isDelegateOnlyType,
    type AdapterConfig,
    type AdapterType,
    type AnthropicAuthMode,
  } from "$lib/types/adapter";
  import {
    ANTHROPIC_MODEL_PRESETS,
    CLAUDE_CODE_MODEL_PRESETS,
    CODEX_MODEL_PRESETS,
    CURSOR_MODEL_PRESETS,
    OPENAI_COMPATIBLE_PROVIDERS,
    defaultDescriptionFor,
    type ModelPreset,
    type ProviderPreset,
  } from "$lib/adapters/presets";
  import AdapterCard from "$lib/components/settings/AdapterCard.svelte";

  type Tab = "adapters" | "prompts" | "skills" | "modules" | "about";
  let tab = $state<Tab>("adapters");

  // ─── Adapters: New-adapter form state ──────────────────────────────────
  let newAdapterOpen = $state(false);
  let newType = $state<AdapterType>("anthropic");
  let newName = $state("");
  let newAuthMode = $state<AnthropicAuthMode>("account");

  // Anthropic preset selection. -1 = "Custom…" (free text).
  let newAnthropicPresetIdx = $state(0);
  let newAnthropicCustomModel = $state("");

  // OpenAI-compatible provider + model selection. providerIdx is an index
  // into OPENAI_COMPATIBLE_PROVIDERS; modelIdx is an index into that
  // provider's models[] (or -1 for free-text model entry).
  let newProviderIdx = $state(0);
  let newProviderModelIdx = $state(0);
  let newProviderCustomModel = $state("");
  // Editable base URL — pre-filled from the selected provider preset, but the
  // user can override (e.g. an LM Studio instance reached over Tailscale on
  // a different host). Empty triggers the preset default at save time.
  let newProviderBaseUrl = $state("");

  // Inline API key for new adapter — saved to the keychain on Add. Empty is
  // valid for local endpoints (Ollama / LM Studio) that don't gate on auth.
  let newApiKey = $state("");

  // Claude Code default-model picker. Same index convention as the
  // Anthropic preset selector: 0..N = preset, -1 = "Custom…" free
  // text, -2 = "Use SDK default" (leave model unset).
  let newClaudeCodePresetIdx = $state(-2);
  let newClaudeCodeCustomModel = $state("");

  // Codex-specific fields. Profile names a section in ~/.codex/config.toml
  // and tells the adapter which model + provider to route through;
  // sandbox is the codex tool-execution policy. Model is an optional
  // per-adapter override of whatever the profile would pick.
  let newCodexProfile = $state("");
  let newCodexSandbox = $state<
    "read-only" | "workspace-write" | "danger-full-access"
  >("danger-full-access");
  let newCodexPresetIdx = $state(-2);
  let newCodexCustomModel = $state("");

  // Cursor default-model picker.
  let newCursorPresetIdx = $state(0);
  let newCursorCustomModel = $state("");

  const selectedClaudeCodePreset = $derived<ModelPreset | null>(
    newClaudeCodePresetIdx >= 0
      ? (CLAUDE_CODE_MODEL_PRESETS[newClaudeCodePresetIdx] ?? null)
      : null,
  );
  const selectedCodexPreset = $derived<ModelPreset | null>(
    newCodexPresetIdx >= 0
      ? (CODEX_MODEL_PRESETS[newCodexPresetIdx] ?? null)
      : null,
  );
  const selectedCursorPreset = $derived<ModelPreset | null>(
    newCursorPresetIdx >= 0
      ? (CURSOR_MODEL_PRESETS[newCursorPresetIdx] ?? null)
      : null,
  );

  const selectedAnthropicPreset = $derived<ModelPreset | null>(
    newAnthropicPresetIdx >= 0
      ? ANTHROPIC_MODEL_PRESETS[newAnthropicPresetIdx]
      : null,
  );
  const selectedProvider = $derived<ProviderPreset>(
    OPENAI_COMPATIBLE_PROVIDERS[newProviderIdx] ??
      OPENAI_COMPATIBLE_PROVIDERS[0],
  );
  const selectedProviderModel = $derived<ModelPreset | null>(
    newProviderModelIdx >= 0
      ? (selectedProvider.models[newProviderModelIdx] ?? null)
      : null,
  );

  // When the provider changes, snap the model selection back to that
  // provider's first preset (or "Custom" if it has none) and pre-fill the
  // base URL with the preset's default. Only `newProviderIdx` is tracked —
  // everything else is read/written inside `untrack` so that typing into
  // the model or base-URL fields doesn't fire this effect (which would
  // otherwise reset the base URL the user just edited).
  $effect(() => {
    const idx = newProviderIdx;
    untrack(() => {
      const provider =
        OPENAI_COMPATIBLE_PROVIDERS[idx] ?? OPENAI_COMPATIBLE_PROVIDERS[0];
      if (provider.models.length === 0) {
        newProviderModelIdx = -1;
        if (!newProviderCustomModel) {
          newProviderCustomModel = provider.defaultModel;
        }
      } else {
        newProviderModelIdx = 0;
      }
      newProviderBaseUrl = provider.baseUrl;
    });
  });

  // Per-row edit state (API key visibility, codex profile/sandbox
  // drafts, cursor model drafts) used to live here, but `AdapterCard`
  // now owns its own per-instance edit toggles and drafts. The parent
  // only handles cross-card concerns (delete, set-default, account
  // info refresh).

  // Account-mode status — populated when an Anthropic/account adapter exists.
  let accountInfo = $state<{
    has: boolean;
    email: string | null;
  } | null>(null);
  async function refreshAccountInfo() {
    try {
      const info = await readClaudeCodeCredentials();
      accountInfo = { has: info.hasCredentials, email: info.email };
    } catch {
      accountInfo = { has: false, email: null };
    }
  }
  $effect(() => {
    void refreshAccountInfo();
  });

  function resetNewAdapter() {
    newAdapterOpen = false;
    newName = "";
    newAuthMode = "account";
    newType = "anthropic";
    newAnthropicPresetIdx = 0;
    newAnthropicCustomModel = "";
    newProviderIdx = 0;
    newProviderModelIdx = 0;
    newProviderCustomModel = "";
    newProviderBaseUrl = OPENAI_COMPATIBLE_PROVIDERS[0].baseUrl;
    newApiKey = "";
    newCodexProfile = "";
    newCodexSandbox = "danger-full-access";
    newClaudeCodePresetIdx = -2;
    newClaudeCodeCustomModel = "";
    newCodexPresetIdx = -2;
    newCodexCustomModel = "";
    newCursorPresetIdx = 0;
    newCursorCustomModel = "";
  }

  /** Translate a preset-index + custom-string pair into the actual model
   *  ID to save on the config. Returns `undefined` for "no model" (the
   *  -2 sentinel) and for an empty custom field, letting the adapter
   *  fall back to whatever default the SDK / profile uses. */
  function pickModelFromPresetIdx(
    idx: number,
    presets: ModelPreset[],
    custom: string,
  ): string | undefined {
    if (idx >= 0) return presets[idx]?.model;
    if (idx === -1) {
      const trimmed = custom.trim();
      return trimmed || undefined;
    }
    return undefined;
  }

  function defaultName(t: AdapterType): string {
    if (t === "anthropic") {
      return selectedAnthropicPreset?.label ?? "Claude";
    }
    if (t === "openai-compatible") {
      const providerLabel = selectedProvider.label;
      const modelLabel =
        selectedProviderModel?.label ?? newProviderCustomModel;
      return modelLabel
        ? `${modelLabel} (${providerLabel})`
        : providerLabel;
    }
    if (t === "codex") return "Codex";
    if (t === "claude-code") return "Claude Code";
    if (t === "cursor") return "Cursor";
    return "Adapter";
  }

  async function addAdapter() {
    const id = `${newType}-${Date.now().toString(36)}`;
    const config: AdapterConfig = {
      id,
      type: newType,
      name: newName.trim() || defaultName(newType),
      // Only auto-promote to orchestrator when this is the first adapter
      // AND the type is orchestrator-capable. Otherwise the app would
      // appear "broken" on first launch — the orchestrator slot would
      // be filled by a delegate-only adapter that immediately errors.
      isOrchestratorDefault:
        adapters.configs.length === 0 && !isDelegateOnlyType(newType),
      isDelegateDefault: adapters.configs.length === 0,
    };
    if (newType === "anthropic") {
      const preset = selectedAnthropicPreset;
      config.model = preset?.model ?? newAnthropicCustomModel.trim() ?? undefined;
      config.context1m = preset?.context1m ?? false;
      config.authMode = newAuthMode;
    } else if (newType === "openai-compatible") {
      const model =
        selectedProviderModel?.model ?? newProviderCustomModel.trim();
      const baseUrl = newProviderBaseUrl.trim() || selectedProvider.baseUrl;
      config.model = model || undefined;
      config.baseUrl = baseUrl || undefined;
    } else if (newType === "claude-code") {
      const m = pickModelFromPresetIdx(
        newClaudeCodePresetIdx,
        CLAUDE_CODE_MODEL_PRESETS,
        newClaudeCodeCustomModel,
      );
      if (m) config.model = m;
    } else if (newType === "codex") {
      const trimmedProfile = newCodexProfile.trim();
      if (trimmedProfile) config.codexProfile = trimmedProfile;
      config.codexSandbox = newCodexSandbox;
      const m = pickModelFromPresetIdx(
        newCodexPresetIdx,
        CODEX_MODEL_PRESETS,
        newCodexCustomModel,
      );
      if (m) config.model = m;
    } else if (newType === "cursor") {
      const m = pickModelFromPresetIdx(
        newCursorPresetIdx,
        CURSOR_MODEL_PRESETS,
        newCursorCustomModel,
      );
      if (m) config.model = m;
    }
    // Prefill the description with a factual baseline if the user didn't
    // supply one. The orchestrator's roster uses this; the user is
    // expected to refine it from here.
    if (!config.description) {
      config.description = defaultDescriptionFor(newType, {
        model: config.model,
        baseUrl: config.baseUrl,
        codexProfile: config.codexProfile,
      });
    }
    await adapters.upsert(config);

    // Stash the inline API key if one was provided. We do this for
    // Anthropic (api-key mode), OpenAI-compatible, and Cursor (which
    // requires a CURSOR_API_KEY from Cursor Dashboard → Integrations).
    // Account-mode Anthropic, Claude Code, and Codex authenticate via
    // their own native flows and don't use this field.
    const needsKey =
      newType === "openai-compatible" ||
      newType === "cursor" ||
      (newType === "anthropic" && newAuthMode === "api-key");
    if (needsKey && newApiKey.trim()) {
      await setAdapterApiKey(id, newApiKey.trim());
    }

    resetNewAdapter();
    void health.probe();
  }

  async function deleteAdapter(id: string) {
    if (!window.confirm("Delete this adapter? Its API key will also be cleared.")) return;
    await clearAdapterApiKey(id).catch(() => {});
    await adapters.remove(id);
    void health.probe();
  }

  async function makeOrchestrator(id: string) {
    await adapters.setOrchestratorDefault(id);
    void health.probe();
  }

  async function makeDelegate(id: string) {
    await adapters.setDelegateDefault(id);
  }

  // Per-card edit handlers (set-auth-mode, key edit, codex/cursor
  // defaults edit) used to live here. They've moved into
  // `AdapterCard` which owns its own per-instance edit state and
  // commits back via the `onUpdate` callback. The card calls our
  // `loadApiKey` / `saveApiKey` / `clearApiKey` callbacks for
  // keychain reads/writes; we just forward those to the same
  // `getAdapterApiKey` / `setAdapterApiKey` / `clearAdapterApiKey`
  // helpers the rest of the page already imports.

  // ─── Prompts ───────────────────────────────────────────────────────────
  let orchestratorPrompt = $state("");
  let delegatePrompt = $state("");
  let promptsLoaded = $state(false);

  async function loadPrompts() {
    orchestratorPrompt = await loadOrchestratorPrompt();
    delegatePrompt = await loadDelegatePrompt();
    promptsLoaded = true;
  }

  $effect(() => {
    if (tab === "prompts" && !promptsLoaded) {
      void loadPrompts();
    }
  });

  async function savePrompts() {
    await saveOrchestratorPrompt(orchestratorPrompt);
    await saveDelegatePrompt(delegatePrompt);
  }

  function resetOrchestrator() {
    orchestratorPrompt = DEFAULT_ORCHESTRATOR_PROMPT;
  }
  function resetDelegate() {
    delegatePrompt = DEFAULT_DELEGATE_PROMPT;
  }

  async function clearChatHistory() {
    if (
      !window.confirm(
        "Clear ALL sessions? This deletes every session's messages and delegate runs from the sidebar. Memories and adapters are kept.",
      )
    ) {
      return;
    }
    const all = await listConversations();
    for (const convo of all) {
      await deleteConversation(convo.id);
    }
    await conversations.refresh();
    // Back to `/`, which lands on a fresh draft (no started sessions left).
    await goto("/");
  }
</script>

<div class="settings">
  <div class="header">
    <h1>Settings</h1>
  </div>

  <nav class="tabs">
    <button
      class:active={tab === "adapters"}
      onclick={() => (tab = "adapters")}
    >
      Adapters
    </button>
    <button
      class:active={tab === "prompts"}
      onclick={() => (tab = "prompts")}
    >
      Prompts
    </button>
    <button class:active={tab === "skills"} onclick={() => (tab = "skills")}>
      Skills
    </button>
    <button
      class:active={tab === "modules"}
      onclick={() => (tab = "modules")}
    >
      Modules
    </button>
    <button class:active={tab === "about"} onclick={() => (tab = "about")}>
      About
    </button>
  </nav>

  {#if tab === "adapters"}
    <section class="panel">
      <p class="intro">
        Configure how the app talks to language models. The
        <strong>orchestrator</strong>
        is who you chat with. <strong>Every other adapter</strong> is
        automatically available as a delegate the orchestrator can call
        by name — write a role/strengths description on each so the
        orchestrator can pick well. The
        <strong>default delegate</strong>
        is the fallback used when the orchestrator doesn't pick a
        specific one.
      </p>

      {#if adapters.configs.length === 0}
        <div class="empty">
          <p>No adapters configured yet. Add one below to start chatting.</p>
        </div>
      {/if}

      {#each adapters.configs as cfg (cfg.id)}
        <AdapterCard
          {cfg}
          {accountInfo}
          onUpdate={(next) => adapters.upsert(next).then(() => health.probe())}
          onDelete={() => deleteAdapter(cfg.id)}
          onSetOrchestrator={() => makeOrchestrator(cfg.id)}
          onSetDelegate={() => makeDelegate(cfg.id)}
          onRefreshAccount={refreshAccountInfo}
          loadApiKey={() => getAdapterApiKey(cfg.id)}
          saveApiKey={async (key) => {
            await setAdapterApiKey(cfg.id, key);
            void health.probe();
          }}
          clearApiKey={async () => {
            await clearAdapterApiKey(cfg.id);
            void health.probe();
          }}
        />
      {/each}

      {#if !newAdapterOpen}
        <button class="primary add" onclick={() => (newAdapterOpen = true)}>
          + Add adapter
        </button>
      {:else}
        <div class="new-adapter">
          <h3>New adapter</h3>
          <label>
            Type
            <select bind:value={newType}>
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="cursor">Cursor</option>
            </select>
          </label>

          {#if newType === "anthropic"}
            <label>
              Model
              <select bind:value={newAnthropicPresetIdx}>
                {#each ANTHROPIC_MODEL_PRESETS as preset, i (preset.label)}
                  <option value={i}>
                    {preset.label}{preset.hint ? ` — ${preset.hint}` : ""}
                  </option>
                {/each}
                <option value={-1}>Custom model ID…</option>
              </select>
            </label>
            {#if newAnthropicPresetIdx === -1}
              <label>
                Custom model ID
                <input
                  type="text"
                  placeholder="claude-…"
                  bind:value={newAnthropicCustomModel}
                />
              </label>
            {/if}
            <label>
              Auth mode
              <select bind:value={newAuthMode}>
                <option value="account">Account (Claude Code login)</option>
                <option value="api-key">API key</option>
              </select>
            </label>
          {:else if newType === "openai-compatible"}
            <label>
              Provider
              <select bind:value={newProviderIdx}>
                {#each OPENAI_COMPATIBLE_PROVIDERS as provider, i (provider.id)}
                  <option value={i}>{provider.label}</option>
                {/each}
              </select>
            </label>
            <label>
              Base URL
              <input
                type="text"
                placeholder="https://your-endpoint/v1"
                bind:value={newProviderBaseUrl}
              />
            </label>
            {#if selectedProvider.id !== "custom"}
              <div class="kv-hint subtle">
                Defaulted from <strong>{selectedProvider.label}</strong>.
                Override the host for remote setups (Tailscale, LAN, etc.).
              </div>
            {/if}
            <label>
              Model
              {#if selectedProvider.models.length > 0}
                <select bind:value={newProviderModelIdx}>
                  {#each selectedProvider.models as preset, i (preset.label)}
                    <option value={i}>
                      {preset.label}{preset.hint ? ` — ${preset.hint}` : ""}
                    </option>
                  {/each}
                  <option value={-1}>Custom model ID…</option>
                </select>
              {:else}
                <input
                  type="text"
                  placeholder={selectedProvider.defaultModel ||
                    "e.g. qwen2.5-coder:32b"}
                  bind:value={newProviderCustomModel}
                />
              {/if}
            </label>
            {#if selectedProvider.models.length > 0 && newProviderModelIdx === -1}
              <label>
                Custom model ID
                <input
                  type="text"
                  placeholder="provider-specific model name"
                  bind:value={newProviderCustomModel}
                />
              </label>
            {/if}
            <label>
              API key
              <input
                type="password"
                placeholder={selectedProvider.requiresApiKey
                  ? "sk-… or provider-specific key"
                  : "Optional — leave blank for local endpoints"}
                bind:value={newApiKey}
                autocomplete="off"
              />
            </label>
            <div class="kv-hint subtle">
              {#if selectedProvider.requiresApiKey}
                Required for {selectedProvider.label}. Stored in the system
                keychain.
              {:else}
                Local endpoints typically don't require a key. Leave blank
                unless your server enforces one.
              {/if}
            </div>
          {/if}

          {#if newType === "anthropic" && newAuthMode === "api-key"}
            <label>
              API key
              <input
                type="password"
                placeholder="sk-ant-…"
                bind:value={newApiKey}
                autocomplete="off"
              />
            </label>
            <div class="kv-hint subtle">
              Get one at <code>console.anthropic.com</code>. Stored in the
              system keychain.
            </div>
          {/if}

          {#if newType === "cursor"}
            <label>
              API key
              <input
                type="password"
                placeholder="key_…"
                bind:value={newApiKey}
                autocomplete="off"
              />
            </label>
            <div class="kv-hint subtle">
              Generate at Cursor Dashboard → Integrations → User API Keys
              (or Service Accounts on Enterprise). Stored in the system
              keychain.
            </div>
          {/if}

          {#if newType === "claude-code"}
            <label>
              Default model
              <select bind:value={newClaudeCodePresetIdx}>
                <option value={-2}>Use Claude Code default</option>
                {#each CLAUDE_CODE_MODEL_PRESETS as preset, i (preset.label)}
                  <option value={i}>
                    {preset.label}{preset.hint ? ` — ${preset.hint}` : ""}
                  </option>
                {/each}
                <option value={-1}>Custom model ID…</option>
              </select>
            </label>
            {#if newClaudeCodePresetIdx === -1}
              <label>
                Custom model ID
                <input
                  type="text"
                  placeholder="claude-…"
                  bind:value={newClaudeCodeCustomModel}
                />
              </label>
            {/if}
            <div class="kv-hint subtle">
              Runs <code>@anthropic-ai/claude-agent-sdk</code> in a
              bundled sidecar. Authenticates with the same keychain
              entry as the Claude Code CLI — sign in once via
              <code>claude /login</code> and this adapter reuses it. No
              API key required. The orchestrator may override the model
              per delegation; this is the fallback.
            </div>
          {/if}

          {#if newType === "codex"}
            <label>
              Codex profile (optional)
              <input
                type="text"
                placeholder="e.g. macstudio-qwen-coder"
                bind:value={newCodexProfile}
              />
            </label>
            <label>
              Default model
              <select bind:value={newCodexPresetIdx}>
                <option value={-2}>Use profile default</option>
                {#each CODEX_MODEL_PRESETS as preset, i (preset.label)}
                  <option value={i}>
                    {preset.label}{preset.hint ? ` — ${preset.hint}` : ""}
                  </option>
                {/each}
                <option value={-1}>Custom model ID…</option>
              </select>
            </label>
            {#if newCodexPresetIdx === -1}
              <label>
                Custom model ID
                <input
                  type="text"
                  placeholder="gpt-5.5 / o3 / etc."
                  bind:value={newCodexCustomModel}
                />
              </label>
            {/if}
            <label>
              Sandbox mode
              <select bind:value={newCodexSandbox}>
                <option value="danger-full-access">danger-full-access</option>
                <option value="workspace-write">workspace-write</option>
                <option value="read-only">read-only</option>
              </select>
            </label>
            <div class="kv-hint subtle">
              Drives <code>codex mcp-server</code> over JSON-RPC. The
              profile picks the model + provider from
              <code>~/.codex/config.toml</code>; the model override
              above (if set) wins over the profile's choice.
              Authentication is whatever <code>codex login</code> set
              up — no API key required here.
            </div>
          {/if}

          {#if newType === "cursor"}
            <label>
              Default model
              <select bind:value={newCursorPresetIdx}>
                {#each CURSOR_MODEL_PRESETS as preset, i (preset.label)}
                  <option value={i}>
                    {preset.label}{preset.hint ? ` — ${preset.hint}` : ""}
                  </option>
                {/each}
                <option value={-1}>Custom model ID…</option>
              </select>
            </label>
            {#if newCursorPresetIdx === -1}
              <label>
                Custom model ID
                <input
                  type="text"
                  placeholder="e.g. gpt-5.3-codex-high"
                  bind:value={newCursorCustomModel}
                />
              </label>
            {/if}
            <div class="kv-hint subtle">
              Runs <code>@cursor/sdk</code>'s <code>Agent.create()</code>
              in a bundled sidecar. Requires an active Cursor
              subscription and an API key from Dashboard → Integrations
              → User API Keys. Inference routes through Cursor's cloud
              (no BYOK). The orchestrator may override the model per
              delegation; this is the fallback.
            </div>
          {/if}

          <label>
            Name
            <input
              type="text"
              placeholder={defaultName(newType)}
              bind:value={newName}
            />
          </label>

          <div class="row">
            <button class="primary" onclick={addAdapter}>Add</button>
            <button onclick={resetNewAdapter}>Cancel</button>
          </div>
        </div>
      {/if}

      <div class="health-row">
        Health: <strong>{health.overall}</strong>
        {#if health.snapshot.adapterName}
          via <code>{health.snapshot.adapterName}</code>
        {/if}
        {#if health.snapshot.message}
          <span class="muted">— {health.snapshot.message}</span>
        {/if}
      </div>
    </section>
  {:else if tab === "prompts"}
    <section class="panel">
      <p class="intro">
        Customize the system prompts. Orchestrator chats with you and delegates;
        delegate is the scoped worker prompt.
      </p>
      {#if !promptsLoaded}
        <div class="loading">Loading…</div>
      {:else}
        <div class="prompt-block">
          <div class="prompt-head">
            <h3>Orchestrator</h3>
            <button onclick={resetOrchestrator}>Reset to default</button>
          </div>
          <textarea bind:value={orchestratorPrompt} rows="14"></textarea>
        </div>
        <div class="prompt-block">
          <div class="prompt-head">
            <h3>Delegate</h3>
            <button onclick={resetDelegate}>Reset to default</button>
          </div>
          <textarea bind:value={delegatePrompt} rows="10"></textarea>
        </div>
        <div class="row">
          <button class="primary" onclick={() => void savePrompts()}>
            Save prompts
          </button>
        </div>
      {/if}
    </section>
  {:else if tab === "skills"}
    <section class="panel">
      <p class="intro">
        Choose which on-disk skill sources show up in the
        <code>/</code>
        menu. Toggling a source on/off rescans immediately. Local skills
        live under <code>~/.desktop-oss/skills/</code>; the other sources point
        at the standard directories used by Claude Code, Cursor, and
        Codex.
      </p>

      <div class="skill-sources">
        {#each ["local", "claude", "cursor", "codex"] as src (src)}
          {@const source = src as SkillSource}
          <label class="skill-source-row">
            <input
              type="checkbox"
              checked={skillsStore.enablement.enabled[source]}
              onchange={(e) =>
                void setSourceEnabled(
                  source,
                  (e.currentTarget as HTMLInputElement).checked,
                )}
            />
            <span class="skill-source-name">{sourceLabel(source)}</span>
            {#if displayPrefix(source)}
              <code class="skill-source-prefix"
                >/{displayPrefix(source)}:…</code
              >
            {:else}
              <code class="skill-source-prefix">/…</code>
            {/if}
          </label>
        {/each}
      </div>

      <div class="skill-actions">
        <button onclick={() => void refreshSkills()}>Rescan now</button>
        <span class="muted">
          {skillsStore.all.length} skill{skillsStore.all.length === 1
            ? ""
            : "s"} loaded
        </span>
      </div>

      {#if skillsStore.error}
        <p class="banner err">Discovery error: {skillsStore.error}</p>
      {/if}

      <h3 class="perm-heading">Skill permissions</h3>
      <p class="perm-intro">
        Shell-command patterns you've approved as "Always allow" when a
        skill ran <code>!`cmd`</code>. Revoke any rule to be prompted
        again next time.
      </p>
      {#if skillPermissions.rules.length === 0}
        <p class="muted perm-empty">No persistent rules yet.</p>
      {:else}
        <ul class="perm-list">
          {#each skillPermissions.rules as rule (rule.pattern)}
            <li class="perm-row">
              <code class="perm-pattern">{rule.pattern}</code>
              <button
                class="perm-revoke"
                onclick={() => void revokeRule(rule.pattern)}
              >
                Revoke
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else if tab === "modules"}
    <section class="panel">
      <p class="intro">
        Modules are drop-in features that can add a tool the agent can call
        and a panel in the right-hand dock. Toggle which ones are active. Add
        one by creating a folder under
        <code>src/lib/modules/&lt;id&gt;/</code> — it appears here
        automatically.
      </p>

      {#if modules.all().length === 0}
        <p class="muted">
          No modules installed yet. Drop one in
          <code>src/lib/modules/</code> and it'll show up here.
        </p>
      {:else}
        <div class="module-list">
          {#each modules.all() as m (m.id)}
            <label class="module-row">
              <input
                type="checkbox"
                checked={modules.isEnabled(m.id)}
                onchange={(e) =>
                  void modules.setEnabled(
                    m.id,
                    (e.currentTarget as HTMLInputElement).checked,
                  )}
              />
              <div class="module-info">
                <div class="module-head">
                  <span class="module-name"
                    >{m.icon ? `${m.icon} ` : ""}{m.label}</span
                  >
                  {#if m.version}
                    <span class="module-version">v{m.version}</span>
                  {/if}
                  {#if m.panel}
                    <code class="skill-source-prefix">panel</code>
                  {/if}
                  {#if m.inputAccessory}
                    <code class="skill-source-prefix">bar</code>
                  {/if}
                </div>
                {#if m.description}
                  <p class="module-desc">{m.description}</p>
                {/if}
                {#if m.author}
                  <p class="module-meta">by {m.author}</p>
                {/if}
              </div>
            </label>
          {/each}
        </div>
      {/if}
    </section>
  {:else if tab === "about"}
    <section class="panel about">
      <h3>Desktop OSS</h3>
      <p>
        Open-source orchestrator-and-agents chat desktop app. Local-first,
        bring your own LLM.
      </p>
      <p>
        <strong>Local data:</strong> conversations and runs are stored in
        SQLite inside this app's data directory. API keys and tokens stay
        on this machine.
      </p>
      <p>
        <strong>Reset:</strong>
        <button onclick={clearChatHistory}>
          Clear all sessions
        </button>
      </p>
    </section>
  {/if}
</div>

<style>
  .settings {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 1.5em 2em;
    color: var(--text);
  }
  .header h1 {
    margin: 0 0 0.6em;
    font-size: 1.6em;
    font-weight: 700;
  }
  .tabs {
    display: flex;
    gap: 0.4em;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.2em;
  }
  .tabs button {
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 0.5em 0.9em;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.95em;
    border-bottom: 2px solid transparent;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 1em;
    max-width: 740px;
  }
  .intro {
    color: var(--text-muted);
    line-height: 1.5;
  }
  .empty {
    padding: 1em;
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    color: var(--text-muted);
    text-align: center;
  }
  /* Per-card chrome (.adapter, .badge, .role, .kv, .auth-mode, .key,
   * button.danger, .account-row .ok/.warn) lives in AdapterCard.svelte.
   * The selectors below are only the ones still used by the
   * new-adapter form and the page-level layout. */
  .kv-hint {
    color: var(--text-muted);
    font-size: 0.84em;
  }
  .kv-hint.subtle {
    font-size: 0.78em;
    color: var(--text-faint);
    line-height: 1.4;
    margin-top: -0.3em;
  }
  .kv-hint code {
    color: var(--text);
    background: var(--code-inline-bg);
    padding: 0.1em 0.4em;
    border-radius: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6em;
    flex-wrap: wrap;
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
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  button.primary:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  button.add {
    align-self: flex-start;
  }
  .new-adapter {
    padding: 1em;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 0.6em;
  }
  .new-adapter h3 {
    margin: 0;
  }
  .new-adapter label {
    display: flex;
    flex-direction: column;
    gap: 0.2em;
    font-size: 0.85em;
    color: var(--text-muted);
  }
  .new-adapter input,
  .new-adapter select {
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text);
    padding: 0.4em 0.6em;
    font-family: inherit;
    font-size: 0.9em;
  }
  .health-row {
    margin-top: 0.5em;
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .muted {
    color: var(--text-faint);
  }
  .prompt-block {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elevated);
    padding: 0.8em;
    display: flex;
    flex-direction: column;
    gap: 0.4em;
  }
  .prompt-head {
    display: flex;
    align-items: center;
    gap: 0.6em;
  }
  .prompt-head h3 {
    flex: 1;
    margin: 0;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text);
    padding: 0.6em;
    font-family: var(--code-mono);
    font-size: 0.84em;
    line-height: 1.5;
    resize: vertical;
  }
  .about p {
    line-height: 1.6;
    color: var(--text-muted);
  }
  .about p strong {
    color: var(--text);
  }
  .loading {
    color: var(--text-muted);
    padding: 1em;
  }
  .skill-sources {
    display: flex;
    flex-direction: column;
    gap: 0.45em;
    margin: 0.6em 0 1.2em 0;
  }
  .skill-source-row {
    display: flex;
    align-items: center;
    gap: 0.8em;
    padding: 0.5em 0.7em;
    border-radius: 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background-color 0.06s ease;
  }
  .skill-source-row:hover {
    background: var(--hover-bg);
  }
  .skill-source-name {
    flex: 0 0 auto;
    color: var(--text);
    font-weight: 400;
    min-width: 120px;
  }
  .skill-source-prefix {
    color: var(--text-faint);
    font-family: var(--code-mono);
    font-size: 0.82em;
    background: transparent;
  }
  .skill-actions {
    display: flex;
    align-items: center;
    gap: 0.8em;
    margin-top: 0.6em;
  }
  .module-list {
    display: flex;
    flex-direction: column;
    gap: 0.5em;
  }
  .module-row {
    display: flex;
    align-items: flex-start;
    gap: 0.8em;
    padding: 0.6em 0.7em;
    border-radius: 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background-color 0.06s ease;
  }
  .module-row:hover {
    background: var(--hover-bg);
  }
  .module-row input {
    margin-top: 0.15em;
  }
  .module-info {
    display: flex;
    flex-direction: column;
    gap: 0.15em;
    min-width: 0;
  }
  .module-head {
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    flex-wrap: wrap;
  }
  .module-name {
    color: var(--text);
    font-weight: 500;
  }
  .module-version {
    color: var(--text-faint);
    font-size: 0.8em;
    font-family: var(--code-mono);
  }
  .module-desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.86em;
  }
  .module-meta {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.8em;
  }
  .banner.err {
    color: var(--danger-text);
    padding: 0.5em 0.7em;
    margin-top: 1em;
    background: rgba(248, 81, 73, 0.08);
    border-radius: 6px;
    border: 1px solid rgba(248, 81, 73, 0.25);
  }
  .perm-heading {
    margin: 2em 0 0.3em;
    font-size: 1.02em;
    font-weight: 600;
  }
  .perm-intro {
    margin: 0 0 0.8em;
    color: var(--text-muted);
    font-size: 0.86em;
    line-height: 1.5;
  }
  .perm-intro code {
    font-family: var(--code-mono);
    background: var(--code-inline-bg);
    padding: 0.05em 0.4em;
    border-radius: 4px;
    color: var(--text);
  }
  .perm-empty {
    font-size: 0.86em;
  }
  .perm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35em;
  }
  .perm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8em;
    padding: 0.5em 0.7em;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .perm-pattern {
    font-family: var(--code-mono);
    color: var(--text);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .perm-revoke {
    background: none;
    border: 1px solid rgba(248, 81, 73, 0.35);
    color: var(--danger-text);
    padding: 0.3em 0.7em;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.82em;
    cursor: pointer;
  }
  .perm-revoke:hover {
    background: rgba(248, 81, 73, 0.08);
  }
</style>
