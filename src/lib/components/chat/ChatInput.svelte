<script lang="ts">
  import {
    pickAttachmentFiles,
    readFileBase64,
    inferMediaType,
  } from "$lib/rust/attachments";
  import AttachmentChip from "$lib/components/chat/AttachmentChip.svelte";
  import PromptBar from "$lib/components/shared/PromptBar.svelte";
  import SlashMenu from "$lib/components/chat/SlashMenu.svelte";
  import ShellPermissionPanel from "$lib/components/permissions/ShellPermissionPanel.svelte";
  import WorkdirBar from "$lib/components/chat/WorkdirBar.svelte";
  import type { ChatStore } from "$lib/stores/chat-store.svelte";
  import {
    shouldShowMenu,
    parseSlashCommand,
    findSlashTrigger,
  } from "$lib/skills/parse-slash";
  import { detectInvocation, lookupSkill } from "$lib/skills/materialise";
  import { getCaretCoordinates } from "$lib/skills/textarea-caret";
  import { filterSkills } from "$lib/skills/filter";
  import { displayName } from "$lib/skills/display";
  import { materialiseInvocation } from "$lib/skills/materialise";
  import { skills as skillsStore } from "$lib/stores/skills.svelte";
  import type { Skill, SkillSource, UsageMap } from "$lib/skills/types";
  import type { SkillInvocationMeta } from "$lib/types/chat";

  interface PendingAttachment {
    filename: string;
    mediaType: string;
    sizeBytes: number;
    dataBase64: string;
  }

  interface Props {
    /** The store backing this composer (its `send`, `sending`,
     *  `queuedCount`, `clearQueue`). Always supplied by ChatSurface. */
    store: ChatStore;
    /** Conversation/session id used as the skill-materialisation scope. */
    sessionId?: string;
    /** Working directory shown in the bar directly above the input. */
    workingDirectory?: string;
    /** Click handler for the folder chip (re-pick a folder). When omitted
     *  the chip renders read-only. */
    onChangeDirectory?: () => void;
    /** Overrides the send handler. The run-detail page passes its own to
     *  wire the same prompt bar into a delegate's continueRun. The
     *  optional `skillContext` carries the invocation metadata and a
     *  materialise() hook that the chat store calls AFTER painting the
     *  user bubble but BEFORE streaming from the model. Falls back to
     *  `store.send` when omitted. */
    onSend?: (
      text: string,
      attachments: PendingAttachment[],
      skillContext?: {
        invocation: SkillInvocationMeta;
        materialise: () => Promise<string | null>;
      },
    ) => Promise<void>;
    /** Overrides the sending/disabled flag. Default: `store.sending`. */
    sending?: boolean;
    /** Placeholder text inside the textarea. Default: "Send a message…". */
    placeholder?: string;
    /** When false, hides the attach button (e.g. delegate runs don't take
     *  attachments yet). Default: true. */
    allowAttachments?: boolean;
    /** When set, the slash-menu filters to skills from this source plus
     *  Local. Used on the delegate surface so a Claude Code delegate
     *  sees only Anthropic+Local skills. `null` (orchestrator default)
     *  shows everything. */
    sourceFilter?: SkillSource | null;
  }

  let {
    store,
    sessionId,
    workingDirectory,
    onChangeDirectory,
    onSend,
    sending,
    placeholder = "Send a message…",
    allowAttachments = true,
    sourceFilter = null,
  }: Props = $props();

  const MAX_ATTACHMENTS = 8;
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

  let textValue = $state("");
  let pending = $state<PendingAttachment[]>([]);
  let pickError = $state<string | null>(null);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  // Slash-menu state. Phase 1 uses a hardcoded fixture; Phase 2 swaps
  // in the live skills store. `dismissedFor` holds the textarea value
  // at the moment the user closed the menu (Esc, or pick) — the menu
  // stays hidden until the content differs from that snapshot.
  let highlightIndex = $state(0);
  let dismissedFor = $state<string | null>(null);
  const usage: UsageMap = {};

  // Pull skills from the live discovery store; the orchestrator
  // surface sees everything, delegate surfaces filter to (local) ∪
  // (their adapter's source family).
  const allSkills = $derived<Skill[]>(
    sourceFilter === null
      ? skillsStore.all
      : skillsStore.all.filter(
          (s) => s.source === "local" || s.source === sourceFilter,
        ),
  );

  const isSending = $derived(sending ?? store.sending);
  // How many messages are already waiting in the post-turn queue.
  // Shown as a small badge so the user knows their queued messages
  // exist and will run when the current turn finishes.
  const queuedCount = $derived(store.queuedCount);

  const filteredSkills = $derived.by(() => {
    const parsed = parseSlashCommand(textValue);
    if (parsed === null) return [];
    return filterSkills(allSkills, parsed.commandName, usage);
  });

  const showSlashMenu = $derived(
    !isSending &&
      shouldShowMenu(textValue) &&
      textValue !== dismissedFor,
  );

  const safeHighlight = $derived(
    filteredSkills.length === 0
      ? 0
      : Math.min(Math.max(0, highlightIndex), filteredSkills.length - 1),
  );

  // Viewport coordinates of the `/` character — the menu anchors its
  // bottom-left to this point so it floats directly above whatever
  // position in the textarea the user typed `/` at.
  const menuAnchor = $derived.by(() => {
    if (!showSlashMenu || !textareaEl) return null;
    const trigger = findSlashTrigger(textValue);
    if (!trigger) return null;
    const coords = getCaretCoordinates(textareaEl, trigger.start);
    const rect = textareaEl.getBoundingClientRect();
    return {
      top: rect.top + coords.top - textareaEl.scrollTop,
      left: rect.left + coords.left - textareaEl.scrollLeft,
      lineHeight: coords.height,
    };
  });

  // Reset the highlight whenever the filtered list changes (typing or
  // menu reopen). Arrow-key navigation only mutates `highlightIndex`,
  // not `filteredSkills`, so the effect leaves keyboard moves alone.
  $effect(() => {
    void filteredSkills;
    highlightIndex = 0;
  });

  function moveHighlight(delta: number) {
    if (filteredSkills.length === 0) return;
    const n = filteredSkills.length;
    highlightIndex = (safeHighlight + delta + n) % n;
  }

  function pickSkill(skill: Skill) {
    const trigger = findSlashTrigger(textValue);
    if (!trigger) return;
    const hasArgs =
      skill.arguments.length > 0 ||
      (skill.argumentHint?.length ?? 0) > 0;
    // Non-local skills get a source prefix so the invocation is
    // unambiguous: `/anthropic:commit`, `/cursor:cursor-review`, etc.
    // Local skills stay bare: `/commit`.
    const insertion = `/${displayName(skill.source, skill.name)}${hasArgs ? " " : ""}`;
    // Splice the insertion in place of the typed `/he` fragment;
    // anything before the trigger AND anything after the cursor is
    // preserved verbatim.
    const before = textValue.slice(0, trigger.start);
    const after = textValue.slice(trigger.end);
    const nextValue = before + insertion + after;
    textValue = nextValue;
    dismissedFor = nextValue;
    highlightIndex = 0;
    if (textareaEl) {
      textareaEl.focus();
      const caret = before.length + insertion.length;
      textareaEl.setSelectionRange(caret, caret);
    }
  }

  const totalBytes = $derived(
    pending.reduce((sum, p) => sum + p.sizeBytes, 0),
  );

  // The user can submit at any time, even mid-turn — the message is
  // queued and runs as the next orchestrator turn. The only gate is
  // "do they have content to send".
  const canSend = $derived(
    textValue.trim().length > 0 || pending.length > 0,
  );

  async function handlePick() {
    pickError = null;
    try {
      const files = await pickAttachmentFiles();
      if (files.length === 0) return;
      for (const file of files) {
        if (pending.length >= MAX_ATTACHMENTS) {
          pickError = `Maximum ${MAX_ATTACHMENTS} attachments per message.`;
          break;
        }
        const payload = await readFileBase64(file.path);
        if (payload.size_bytes > MAX_FILE_BYTES) {
          pickError = `${file.filename} is too large (limit ${MAX_FILE_BYTES / (1024 * 1024)} MB).`;
          continue;
        }
        if (totalBytes + payload.size_bytes > MAX_TOTAL_BYTES) {
          pickError = `Total attachment size would exceed ${MAX_TOTAL_BYTES / (1024 * 1024)} MB.`;
          continue;
        }
        pending = [
          ...pending,
          {
            filename: file.filename,
            mediaType: inferMediaType(file.filename),
            sizeBytes: payload.size_bytes,
            dataBase64: payload.data_base64,
          },
        ];
      }
    } catch (err) {
      pickError = err instanceof Error ? err.message : "Could not read file";
    }
  }

  function removeAttachment(index: number) {
    pending = pending.filter((_, i) => i !== index);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (showSlashMenu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveHighlight(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveHighlight(-1);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const picked = filteredSkills[safeHighlight];
        if (picked) pickSkill(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedFor = textValue;
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const picked = filteredSkills[safeHighlight];
        if (picked) {
          event.preventDefault();
          pickSkill(picked);
          return;
        }
        // No skills match — fall through to send-as-literal.
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  async function handleSend() {
    if (!canSend) return;
    const text = textValue;
    const attachments = pending.slice();
    textValue = "";
    pending = [];
    pickError = null;
    if (textareaEl) textareaEl.style.height = "auto";

    // Skill invocation detection: parse the slash command synchronously
    // so we know what skill (if any) is being invoked. Materialisation
    // is deferred — passed as an async hook so chat.send can paint the
    // user bubble BEFORE the permission panel appears.
    const skillScopeId = sessionId ?? "";
    const detected = detectInvocation(text);
    const skill = detected
      ? lookupSkill(detected.commandName, allSkills)
      : null;
    const skillContext =
      skill && detected
        ? {
            invocation: {
              name: skill.name,
              source: skill.source,
              context: skill.context,
              args: detected.rawArgs,
            } satisfies SkillInvocationMeta,
            materialise: async (): Promise<string | null> => {
              const result = await materialiseInvocation(
                text,
                allSkills,
                skillScopeId,
              );
              return result?.expandedBody ?? null;
            },
          }
        : undefined;

    if (onSend) {
      await onSend(text, attachments, skillContext);
    } else {
      await store.send(text, attachments, skillContext);
    }
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 280)}px`;
  }
</script>

<PromptBar>
  {#snippet header()}
    <ShellPermissionPanel />
    {#if showSlashMenu}
      <SlashMenu
        skills={filteredSkills}
        highlightIndex={safeHighlight}
        onPick={pickSkill}
        onHighlightChange={(i) => (highlightIndex = i)}
        anchor={menuAnchor}
      />
    {/if}
    {#if queuedCount > 0}
      <div class="queue-badge" data-testid="chat-queue-badge">
        <span class="dot"></span>
        {queuedCount} message{queuedCount === 1 ? "" : "s"} queued — will run after the current turn
        <button
          type="button"
          class="link"
          onclick={() => store.clearQueue()}
          title="Drop queued messages"
        >clear</button>
      </div>
    {/if}
    {#if workingDirectory}
      <WorkdirBar
        {workingDirectory}
        conversationId={sessionId ?? ""}
        {onChangeDirectory}
      />
    {/if}
  {/snippet}
  {#if allowAttachments && (pending.length > 0 || pickError)}
    <div class="tray">
      {#each pending as att, i (att.filename + i)}
        <AttachmentChip
          filename={att.filename}
          mediaType={att.mediaType}
          sizeBytes={att.sizeBytes}
          dataBase64={att.dataBase64}
          onRemove={() => removeAttachment(i)}
        />
      {/each}
      {#if pickError}
        <div class="pick-error">{pickError}</div>
      {/if}
    </div>
  {/if}
  <textarea
    bind:this={textareaEl}
    bind:value={textValue}
    oninput={autoResize}
    onkeydown={handleKeyDown}
    placeholder={isSending && queuedCount === 0
      ? "Send a follow-up (will run after the current turn)…"
      : placeholder}
    rows="1"
  ></textarea>
  <div class="controls">
    <div class="left-controls">
      {#if allowAttachments}
        <button
          type="button"
          class="plus-btn"
          aria-label="Attach files"
          onclick={handlePick}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      {/if}
    </div>
    <button
      type="button"
      class="send-btn"
      aria-label="Send message"
      onclick={handleSend}
      disabled={!canSend}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    </button>
  </div>
</PromptBar>

<style>
  .queue-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    align-self: flex-start;
    padding: 0.3em 0.7em;
    margin-bottom: 0.4em;
    border-radius: 999px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.78em;
    line-height: 1.3;
  }
  .queue-badge .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .queue-badge .link {
    background: transparent;
    border: 0;
    color: var(--accent-text, var(--accent));
    cursor: pointer;
    padding: 0;
    font: inherit;
    text-decoration: underline;
  }
  .tray {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5em;
    align-items: center;
    padding: 0.5em 0.7em 0.2em 0.7em;
  }
  .pick-error {
    font-size: 0.82em;
    color: var(--danger-text);
    flex-basis: 100%;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    background: transparent;
    border: none;
    padding: 0.85em 1.1em 0.4em 1.1em;
    color: var(--text);
    font-family: inherit;
    font-size: var(--text-body);
    font-weight: 300;
    line-height: 1.55;
    max-height: 280px;
    min-height: 1.55em;
    overflow-y: auto;
  }
  textarea:focus {
    outline: none;
  }
  textarea::placeholder {
    color: var(--text-muted);
    font-weight: 300;
  }
  textarea:disabled {
    cursor: not-allowed;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.15em 0.35em 0.1em 0.35em;
  }
  .left-controls {
    display: flex;
    align-items: center;
    gap: 0.4em;
  }
  .plus-btn {
    width: 32px;
    height: 32px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .plus-btn:hover:not(:disabled) {
    background: var(--hover-bg);
    color: var(--text);
    border-color: var(--text-faint);
  }
  .plus-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .send-btn {
    width: 36px;
    height: 36px;
    border-radius: 999px;
    border: none;
    background: var(--text);
    color: var(--bg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background-color 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
  }
  .send-btn:hover:not(:disabled) {
    background: var(--text-muted);
  }
  .send-btn:disabled {
    background: var(--border-strong);
    color: var(--text-faint);
    cursor: not-allowed;
  }
</style>
