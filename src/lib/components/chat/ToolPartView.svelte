<script lang="ts">
  import type { ToolPart } from "$lib/types/chat";
  import ToolCodeBlock from "./ToolCodeBlock.svelte";
  import ToolOutputDisclosure from "./ToolOutputDisclosure.svelte";
  import { summarizeToolCall } from "./tool-summary";
  import {
    languageForPath,
    stringInput,
    buildDiff,
  } from "./tool-body-helpers";
  import { harnesses } from "$lib/stores/harnesses.svelte";
  import { moduleForToolName } from "$lib/modules/registry";
  import { requestOpenPanel } from "$lib/modules/dock-actions";
  import { getModuleState, markModuleStateTouched } from "$lib/modules/host";

  interface Props {
    part: ToolPart;
    /** Lets a module tool's cockpit entry replay ITS OWN call (see
     *  AppModule.restoreToolCall) instead of just re-opening the panel on
     *  whatever a later call last showed. Omitted on surfaces with no real
     *  conversation id yet (delegate runs, an un-promoted draft session). */
    conversationId?: string;
  }

  let { part, conversationId }: Props = $props();

  const toolName = $derived(part.type.replace(/^tool-/, ""));

  const input = $derived(
    part.input && typeof part.input === "object"
      ? (part.input as Record<string, unknown>)
      : null,
  );

  const hasOutput = $derived(
    part.state === "output-available" || part.state === "output-error",
  );

  const outputObj = $derived.by<Record<string, unknown> | null>(() => {
    if (!hasOutput) return null;
    if (part.state === "output-error") return null;
    const out = part.output;
    if (out && typeof out === "object" && !Array.isArray(out)) {
      return out as Record<string, unknown>;
    }
    return null;
  });

  const outputText = $derived.by<string | null>(() => {
    if (!hasOutput) return null;
    if (part.state === "output-error") return part.errorText ?? null;
    const out = part.output;
    if (out === null || out === undefined) return null;
    if (typeof out === "string") return out;
    try {
      return JSON.stringify(out, null, 2);
    } catch {
      return String(out);
    }
  });

  const awaiting = $derived(
    part.state === "input-streaming" || part.state === "input-available",
  );

  // delegate_task: structured DelegateResult unwrap.
  const delegateHarness = $derived.by<
    { id: string; name: string; type: string } | null
  >(() => {
    if (toolName !== "delegate_task") return null;
    const h = outputObj?.harness;
    if (h && typeof h === "object") {
      return h as { id: string; name: string; type: string };
    }
    return null;
  });
  const delegateStatus = $derived(
    toolName === "delegate_task" && outputObj?.status
      ? String(outputObj.status)
      : null,
  );
  const delegateSummary = $derived(
    toolName === "delegate_task" && typeof outputObj?.summary === "string"
      ? (outputObj.summary as string)
      : null,
  );
  const delegateFiles = $derived.by<string[]>(() => {
    if (toolName !== "delegate_task") return [];
    const f = outputObj?.filesChanged;
    return Array.isArray(f) ? (f as unknown[]).map(String) : [];
  });
  const delegateDuration = $derived(
    toolName === "delegate_task" && typeof outputObj?.durationMs === "number"
      ? `${Math.round((outputObj.durationMs as number) / 100) / 10}s`
      : null,
  );

  // Best-guess agent name while the delegate is running — pulled from the
  // configured delegate harness. Once the run finishes we switch to the
  // harness the result actually carries (so e.g. fallback-to-orchestrator
  // is visible).
  const runningHarnessName = $derived(
    harnesses.delegateConfig?.name ?? "delegate",
  );
  const delegateLabel = $derived.by(() => {
    if (toolName !== "delegate_task") return null;
    if (awaiting) return `Launching ${runningHarnessName} delegate`;
    if (delegateHarness) return `Launched ${delegateHarness.name} delegate`;
    return "Launched delegate";
  });

  // Generic verb/detail for non-delegate tools.
  const { verb, detail } = $derived(summarizeToolCall(toolName, input));

  // todo_update: normalized checklist (Plan 03). Items ride in `input`.
  const todoItems = $derived.by<Array<{ content: string; status: string }>>(
    () => {
      if (toolName !== "todo_update") return [];
      const items = (input?.items ?? null) as unknown;
      if (!Array.isArray(items)) return [];
      const out: Array<{ content: string; status: string }> = [];
      for (const it of items) {
        if (it && typeof it === "object") {
          const content = (it as { content?: unknown }).content;
          const status = (it as { status?: unknown }).status;
          if (typeof content === "string") {
            out.push({
              content,
              status: typeof status === "string" ? status : "pending",
            });
          }
        }
      }
      return out;
    },
  );

  let expanded = $state(false);

  // A module's own tool (namespaced `${moduleId}_...`, e.g. `fretboard_show`)
  // opens that module's panel on click instead of toggling the generic JSON
  // disclosure below — the panel IS the useful view for these.
  const panelModule = $derived(moduleForToolName(toolName));

  function handleHeaderClick() {
    if (panelModule) {
      if (panelModule.restoreToolCall && conversationId) {
        const state = getModuleState(conversationId, panelModule);
        // `state` is undefined for a module that declares restoreToolCall but
        // no createState (nothing to replay onto) — guard rather than trust
        // the two are always paired. Mark it touched first so a background
        // hydrate() can't clobber the replayed historical view.
        if (state !== undefined) {
          markModuleStateTouched(conversationId, panelModule.id);
          panelModule.restoreToolCall(state, toolName, part.input);
        }
      }
      requestOpenPanel(panelModule.id);
      return;
    }
    expanded = !expanded;
  }
</script>

<div class="tool-entry" data-testid="tool-entry" data-tool={toolName}>
  <button
    type="button"
    class="head"
    onclick={handleHeaderClick}
    aria-expanded={panelModule ? undefined : expanded}
    data-testid="tool-entry-head"
  >
    {#if toolName === "delegate_task"}
      <span class="verb delegate" class:shimmer={awaiting}
        >{delegateLabel}</span
      >
    {:else}
      <span class="verb">{verb}</span>
      {#if detail}
        <code class="detail">{detail}</code>
      {/if}
    {/if}
    <svg
      class="chev"
      class:open={expanded}
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  </button>

  {#if expanded}
    <div class="body" data-testid="tool-entry-body">
      {#if toolName === "delegate_task"}
        {@const task = stringInput(input, "task")}
        {@const context = stringInput(input, "context")}
        {#if delegateHarness}
          <div class="sub-caption">
            ran on <code>{delegateHarness.name}</code> ({delegateHarness.type}){#if delegateDuration}
              · {delegateDuration}
            {/if}
          </div>
        {/if}
        {#if task}
          <ToolCodeBlock content={task} language="markdown" caption="Task" />
        {/if}
        {#if context}
          <ToolOutputDisclosure label="Context" testid="delegate-context">
            <ToolCodeBlock content={context} language="markdown" />
          </ToolOutputDisclosure>
        {/if}
        {#if delegateSummary}
          <ToolOutputDisclosure label="Summary" testid="delegate-summary">
            <ToolCodeBlock content={delegateSummary} language="markdown" />
          </ToolOutputDisclosure>
        {:else if awaiting}
          <div class="awaiting">Delegate is working…</div>
        {/if}
        {#if delegateFiles.length > 0}
          <ToolOutputDisclosure
            label="Files changed"
            summary={`${delegateFiles.length}`}
            testid="delegate-files"
          >
            <ul class="files">
              {#each delegateFiles as f (f)}
                <li><code>{f}</code></li>
              {/each}
            </ul>
          </ToolOutputDisclosure>
        {/if}
        {#if delegateStatus && delegateStatus !== "SUCCEEDED"}
          <div class="sub-caption">status: {delegateStatus}</div>
        {/if}
        {#if part.state === "output-error" && part.errorText}
          <ToolOutputDisclosure label="Error" testid="delegate-error">
            <ToolCodeBlock content={part.errorText} language="text" />
          </ToolOutputDisclosure>
        {/if}

      {:else if toolName === "todo_update"}
        {#if todoItems.length > 0}
          <ul class="todos">
            {#each todoItems as item, i (i)}
              <li class="todo" data-status={item.status}>
                <span class="todo-box" aria-hidden="true"
                  >{item.status === "completed"
                    ? "✓"
                    : item.status === "in_progress"
                      ? "▶"
                      : "○"}</span
                >
                <span class="todo-text">{item.content}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="awaiting">No todos.</div>
        {/if}

      {:else if toolName === "read_file"}
        {@const filePath = stringInput(input, "path")}
        {#if outputObj && typeof outputObj.contents === "string"}
          <ToolCodeBlock
            content={outputObj.contents as string}
            language={languageForPath(filePath)}
            caption={filePath}
            openPathOnClick={filePath}
          />
        {:else if awaiting}
          {#if filePath}<div class="caption">{filePath}</div>{/if}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else if toolName === "list_files"}
        {@const path = stringInput(input, "path")}
        {#if path}<div class="caption">{path}</div>{/if}
        {#if outputText}
          <ToolCodeBlock content={outputText} language="json" />
        {:else if awaiting}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else if toolName === "remember" || toolName === "recall"}
        {#if input}
          <ToolCodeBlock
            content={JSON.stringify(input, null, 2)}
            language="json"
            caption="Input"
          />
        {/if}
        {#if outputText}
          <ToolOutputDisclosure label="Result" testid="memory-result">
            <ToolCodeBlock content={outputText} language="json" />
          </ToolOutputDisclosure>
        {:else if awaiting}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else if toolName === "Bash"}
        {@const command = stringInput(input, "command")}
        {@const description = stringInput(input, "description")}
        {#if description}<div class="caption">{description}</div>{/if}
        {#if command}<ToolCodeBlock content={command} language="bash" />{/if}
        {#if outputText !== null}
          <ToolOutputDisclosure label="Output" testid="bash-output">
            <ToolCodeBlock content={outputText} language="text" />
          </ToolOutputDisclosure>
        {:else if awaiting}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else if toolName === "Read"}
        {@const filePath = stringInput(input, "file_path") || stringInput(input, "path")}
        {#if outputText !== null}
          <ToolCodeBlock
            content={outputText}
            language={languageForPath(filePath)}
            caption={filePath}
            openPathOnClick={filePath}
          />
        {:else if awaiting}
          {#if filePath}<div class="caption">{filePath}</div>{/if}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else if toolName === "Write"}
        {@const filePath = stringInput(input, "file_path") || stringInput(input, "path")}
        {@const content = stringInput(input, "content")}
        {#if content}
          <ToolCodeBlock
            content={content}
            language={languageForPath(filePath)}
            caption={filePath}
            openPathOnClick={filePath}
            showLineNumbers={true}
          />
        {/if}
        {#if outputText !== null}
          <ToolOutputDisclosure label="Result" testid="write-result">
            <ToolCodeBlock content={outputText} language="text" />
          </ToolOutputDisclosure>
        {:else if awaiting}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else if toolName === "Edit" || toolName === "MultiEdit"}
        {@const filePath = stringInput(input, "file_path") || stringInput(input, "path")}
        {@const oldStr = stringInput(input, "old_string")}
        {@const newStr = stringInput(input, "new_string")}
        <ToolCodeBlock
          content={buildDiff(oldStr, newStr)}
          language="diff"
          caption={filePath}
          openPathOnClick={filePath}
        />
        {#if outputText !== null}
          <ToolOutputDisclosure label="Result" testid="edit-result">
            <ToolCodeBlock content={outputText} language="text" />
          </ToolOutputDisclosure>
        {:else if awaiting}
          <div class="awaiting">Awaiting result…</div>
        {/if}

      {:else}
        {#if input}
          <ToolCodeBlock
            content={JSON.stringify(input, null, 2)}
            language="json"
            caption="Input"
          />
        {/if}
        {#if outputText !== null}
          <ToolOutputDisclosure label="Output" testid="tool-output">
            <ToolCodeBlock content={outputText} language="json" />
          </ToolOutputDisclosure>
        {:else if awaiting}
          <div class="awaiting">Awaiting result…</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Layout matches desktop-oss's cockpit ToolEntry exactly: no border,
   * no background, no card. The tool entry is just inline text that
   * expands into a column when toggled. */
  .tool-entry {
    display: block;
  }
  .head {
    display: inline-flex;
    align-items: baseline;
    gap: 0.5em;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 0.1em 0;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--text-meta);
    text-align: left;
    max-width: 100%;
  }
  .head:hover {
    color: var(--text);
  }
  .head:hover .detail {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .verb {
    flex: 0 0 auto;
    font-style: italic;
  }
  /* delegate_task: drop the italic since the label IS the verb; add a
   * gentle shimmer while the delegate is running, mirroring the
   * orchestrator's thinking-indicator pattern. */
  .verb.delegate {
    font-style: normal;
  }
  .verb.delegate.shimmer {
    background: linear-gradient(
      90deg,
      var(--text-muted) 0%,
      var(--text) 50%,
      var(--text-muted) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation: tool-shimmer 1.8s ease-in-out infinite;
  }
  @keyframes tool-shimmer {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: -100% 0;
    }
  }
  .detail {
    flex: 0 1 auto;
    font-family: var(--code-mono);
    color: var(--text-muted);
    background: var(--code-inline-bg);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.1em 0.4em;
    font-size: 0.95em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60ch;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .chev {
    flex: 0 0 auto;
    color: var(--text-faint);
    transition: transform 0.12s ease;
    margin-left: 0.1em;
    position: relative;
    top: 1px;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .body {
    margin: 0.4em 0 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.55em;
    min-width: 0;
  }
  .caption {
    font-family: var(--code-mono);
    font-size: var(--text-meta);
    color: var(--text-muted);
    word-break: break-all;
  }
  .sub-caption {
    font-size: var(--text-meta);
    color: var(--text-muted);
    font-style: italic;
  }
  .sub-caption code {
    font-family: var(--code-mono);
    background: var(--code-inline-bg);
    border-radius: 4px;
    padding: 0.05em 0.35em;
    font-style: normal;
    color: var(--text);
  }
  .awaiting {
    font-size: var(--text-caption);
    color: var(--text-faint);
    font-style: italic;
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: var(--text-meta);
    color: var(--text);
  }
  .files li {
    line-height: 1.5;
  }
  .files code {
    font-family: var(--code-mono);
    background: var(--code-inline-bg);
    border-radius: 4px;
    padding: 0.05em 0.35em;
  }
  .todos {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3em;
    font-size: var(--text-meta);
  }
  .todo {
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    color: var(--text);
  }
  .todo-box {
    flex: 0 0 auto;
    font-family: var(--code-mono);
    color: var(--text-faint);
    width: 1em;
    text-align: center;
  }
  .todo[data-status="in_progress"] .todo-box {
    color: var(--accent-text, var(--accent));
  }
  .todo[data-status="completed"] .todo-box {
    color: var(--success);
  }
  .todo[data-status="completed"] .todo-text {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .todo-text {
    flex: 1 1 auto;
    min-width: 0;
    word-break: break-word;
  }
</style>
