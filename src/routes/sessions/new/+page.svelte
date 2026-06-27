<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { homeDir } from "$lib/skills/rust";
  import {
    createOrchestratorChatStore,
    type OrchestratorChatStore,
  } from "$lib/stores/chat.svelte";
  import { conversations } from "$lib/stores/conversations.svelte";
  import { repoStatus } from "$lib/stores/repo-status.svelte";
  import { pickDirectory } from "$lib/rust/pick-directory";
  import ChatSurface from "$lib/components/chat/ChatSurface.svelte";

  // A draft session: no conversation row exists yet. The store creates it
  // on the first send (so an untouched draft never lands in the sidebar),
  // then `onConversationCreated` promotes this view to the real session.
  let workingDirectory = $state<string>("");
  let handle = $state<OrchestratorChatStore | null>(null);

  const status = $derived(repoStatus.statusFor(workingDirectory));

  onMount(async () => {
    // "+" on a sidebar group passes ?dir=<that folder>; otherwise default
    // to the home directory.
    workingDirectory =
      page.url.searchParams.get("dir") || (await homeDir()) || "/";
    void repoStatus.refresh(workingDirectory);

    handle = createOrchestratorChatStore({
      conversationId: null,
      getWorkingDirectory: () => workingDirectory,
      onConversationCreated: (id) => {
        // Swap the URL to the real session WITHOUT remounting (the in-flight
        // turn keeps streaming on this same store), and reveal it in the
        // sidebar now that it has its first message.
        replaceState(`/sessions/${id}`, {});
        void conversations.refresh();
      },
    });
    await handle.store.hydrate();
  });

  onDestroy(() => handle?.dispose());

  async function changeDirectory() {
    const picked = await pickDirectory(workingDirectory);
    if (!picked) return;
    workingDirectory = picked;
    void repoStatus.refresh(picked);
  }
</script>

<div class="surface">
  {#if handle}
    <ChatSurface
      store={handle.store}
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
</style>
