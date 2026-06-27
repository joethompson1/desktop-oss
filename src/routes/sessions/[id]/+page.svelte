<script lang="ts">
  import { page } from "$app/state";
  import {
    getConversation,
    updateConversationWorkingDirectory,
  } from "$lib/db/conversations";
  import {
    createOrchestratorChatStore,
    type OrchestratorChatStore,
  } from "$lib/stores/chat.svelte";
  import { conversations } from "$lib/stores/conversations.svelte";
  import { repoStatus } from "$lib/stores/repo-status.svelte";
  import { pickDirectory } from "$lib/rust/pick-directory";
  import ChatSurface from "$lib/components/chat/ChatSurface.svelte";

  const sessionId = $derived(page.params.id ?? "");

  let handle = $state<OrchestratorChatStore | null>(null);
  let workingDirectory = $state<string>("");
  let loadError = $state<string | null>(null);

  const status = $derived(repoStatus.statusFor(workingDirectory));

  // One orchestrator store per session id. Rebuilt (and the previous one
  // disposed — unsubscribing its completion listener + clearing its timer)
  // whenever the route param changes. The store reads `workingDirectory`
  // through a getter, so re-picking the folder takes effect on the next turn.
  $effect(() => {
    const id = sessionId;
    if (!id) return;
    let disposed = false;
    let local: OrchestratorChatStore | null = null;
    handle = null;
    loadError = null;

    void (async () => {
      try {
        const convo = await getConversation(id);
        if (disposed) return;
        if (!convo) {
          loadError = "Session not found.";
          return;
        }
        workingDirectory = convo.workingDirectory ?? "";
        void repoStatus.refresh(workingDirectory);
        local = createOrchestratorChatStore({
          conversationId: id,
          getWorkingDirectory: () => workingDirectory,
        });
        handle = local;
        await local.store.hydrate();
      } catch (err) {
        if (!disposed) {
          loadError =
            err instanceof Error ? err.message : "Failed to load session";
        }
      }
    })();

    return () => {
      disposed = true;
      local?.dispose();
    };
  });

  async function changeDirectory() {
    const picked = await pickDirectory(workingDirectory);
    if (!picked || picked === workingDirectory) return;
    workingDirectory = picked;
    await updateConversationWorkingDirectory(sessionId, picked);
    void repoStatus.refresh(picked, true);
    await conversations.refresh();
  }
</script>

<div class="surface">
  {#if loadError}
    <div class="banner err">{loadError}</div>
  {:else if handle}
    <ChatSurface
      store={handle.store}
      {sessionId}
      {workingDirectory}
      repoStatus={status}
      onChangeDirectory={changeDirectory}
    />
  {/if}
</div>

<style>
  .surface {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .banner {
    padding: 0.7em 1.4em;
  }
  .banner.err {
    color: var(--danger-text);
  }
</style>
