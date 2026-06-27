<script lang="ts">
  import { isImageMediaType } from "$lib/rust/attachments";

  interface Props {
    filename: string;
    mediaType: string;
    sizeBytes: number;
    dataBase64?: string;
    onRemove?: () => void;
  }

  const { filename, mediaType, sizeBytes, dataBase64, onRemove }: Props =
    $props();

  const isImage = $derived(isImageMediaType(mediaType));
  const dataUrl = $derived(
    isImage && dataBase64 ? `data:${mediaType};base64,${dataBase64}` : null,
  );

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="chip" class:image={isImage && dataUrl}>
  {#if dataUrl}
    <img src={dataUrl} alt={filename} />
  {:else}
    <div class="icon">📎</div>
  {/if}
  <div class="meta">
    <div class="name" title={filename}>{filename}</div>
    <div class="size">{formatBytes(sizeBytes)}</div>
  </div>
  {#if onRemove}
    <button
      type="button"
      class="remove"
      aria-label={`Remove ${filename}`}
      onclick={onRemove}
    >
      ✕
    </button>
  {/if}
</div>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.35em 0.5em 0.35em 0.55em;
    border-radius: 8px;
    background-color: var(--bg-elevated);
    border: 1px solid var(--border);
    max-width: 240px;
  }
  .chip.image {
    padding: 0.25em 0.5em 0.25em 0.25em;
  }
  img {
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: 4px;
    flex: 0 0 auto;
  }
  .icon {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1em;
    flex: 0 0 auto;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }
  .name {
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    font-size: 0.72em;
    color: var(--text-muted);
  }
  .remove {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85em;
    padding: 0 0.2em;
    flex: 0 0 auto;
  }
  .remove:hover {
    color: var(--text);
  }
</style>
