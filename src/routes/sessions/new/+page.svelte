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
  import { pickDirectory } from "$lib/rust/pick-directory";
  import { ui } from "$lib/stores/ui.svelte";
  import ChatSurface from "$lib/components/chat/ChatSurface.svelte";

  // A draft session: no conversation row exists yet. The store creates it
  // on the first send (so an untouched draft never lands in the sidebar),
  // then `onConversationCreated` promotes this view to the real session.
  let workingDirectory = $state<string>("");
  let handle = $state<OrchestratorChatStore | null>(null);
  // Set once promoted — threaded to ChatSurface so a module tool's cockpit
  // entry can resolve its state (see ToolPartView's conversationId prop),
  // and pushed into ui.activeConversationId so the right dock activates
  // immediately (page.params.id doesn't update reactively here — see
  // ui.svelte.ts's activeConversationId doc comment).
  let sessionId = $state<string>("");

  onMount(async () => {
    // "+" on a sidebar group passes ?dir=<that folder>; otherwise default
    // to the home directory.
    workingDirectory =
      page.url.searchParams.get("dir") || (await homeDir()) || "/";

    handle = createOrchestratorChatStore({
      conversationId: null,
      getWorkingDirectory: () => workingDirectory,
      onConversationCreated: (id) => {
        // Swap the URL to the real session WITHOUT remounting (the in-flight
        // turn keeps streaming on this same store), and reveal it in the
        // sidebar now that it has its first message.
        replaceState(`/sessions/${id}`, {});
        sessionId = id;
        ui.setActiveConversationId(id);
        void conversations.refresh();
      },
    });
    await handle.store.hydrate();
  });

  // Clear ui.activeConversationId only if we still own it. Clearing
  // unconditionally would be unsafe: if this promoted draft is navigated away
  // from, the next page (sessions/[id] or another) may already have set its
  // own id before this destroy runs (ordering isn't guaranteed), and wiping it
  // would deactivate the dock on the new route. Guarding on equality also
  // stops a promoted-then-jump-to-a-non-session-route flow from leaving a
  // stale id behind (which would show the dock on a route with no conversation).
  onDestroy(() => {
    if (ui.activeConversationId === sessionId) ui.setActiveConversationId("");
    handle?.dispose();
  });

  async function changeDirectory() {
    const picked = await pickDirectory(workingDirectory);
    if (!picked) return;
    workingDirectory = picked;
  }
</script>

<div class="surface">
  {#if handle}
    <ChatSurface
      store={handle.store}
      {sessionId}
      {workingDirectory}
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
