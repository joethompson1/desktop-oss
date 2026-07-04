<script lang="ts">
  // The bar above the prompt input: the clickable working-directory chip,
  // followed by each enabled module's input accessory (see
  // `AppModule.inputAccessory`) — the prompt-bar counterpart of RightDock.
  import { modules } from "$lib/modules/store.svelte";
  import { getModuleState } from "$lib/modules/host";

  interface Props {
    workingDirectory: string;
    conversationId: string;
    onChangeDirectory?: () => void;
  }

  let { workingDirectory, conversationId, onChangeDirectory }: Props =
    $props();

  function dirBasename(dir: string): string {
    const trimmed = dir.replace(/\/+$/, "");
    const slash = trimmed.lastIndexOf("/");
    return slash >= 0 ? trimmed.slice(slash + 1) || trimmed : trimmed;
  }

  const folderName = $derived(dirBasename(workingDirectory));
  const accessoryModules = $derived(modules.inputAccessories());
</script>

<div class="workdir-bar" data-testid="workdir-bar">
  <button
    type="button"
    class="folder"
    disabled={!onChangeDirectory}
    title={onChangeDirectory
      ? `${workingDirectory} — click to change`
      : workingDirectory}
    onclick={() => onChangeDirectory?.()}
  >
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3l1.2 1.4h6.8a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.5Z" />
    </svg>
    <span class="folder-name">{folderName}</span>
    {#if onChangeDirectory}
      <svg class="caret" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4 6 8 10 12 6" />
      </svg>
    {/if}
  </button>

  {#each accessoryModules as m (m.id)}
    {#if m.inputAccessory}
      {@const Accessory = m.inputAccessory.component}
      <Accessory
        state={getModuleState(conversationId, m)}
        {conversationId}
        {workingDirectory}
      />
    {/if}
  {/each}
</div>

<style>
  .workdir-bar {
    display: flex;
    align-items: center;
    gap: 0.5em;
    align-self: stretch;
    padding: 0.2em 0.3em;
    margin-bottom: 0.45em;
    font-size: 0.8em;
    color: var(--text-muted);
    min-width: 0;
  }
  .folder {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    flex: 0 0 auto;
    max-width: 220px;
    padding: 0.25em 0.55em;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--text-muted);
    font-family: inherit;
    font-size: inherit;
    line-height: 1.3;
    cursor: pointer;
  }
  .folder:hover:not(:disabled) {
    background: var(--hover-bg);
    border-color: var(--border);
    color: var(--text);
  }
  .folder:disabled {
    cursor: default;
  }
  .folder svg {
    flex: 0 0 auto;
    color: var(--text-faint);
  }
  .folder:hover:not(:disabled) svg {
    color: var(--text-muted);
  }
  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--code-mono);
  }
  .folder .caret {
    margin-left: 0.05em;
  }
</style>
