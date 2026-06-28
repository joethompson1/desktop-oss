// Layout load: hydrate all the stores before the first render so the
// chat surface is ready to go. SSR is off because this is a Tauri app.

import { adapters } from "$lib/stores/adapters.svelte";
import { auth } from "$lib/stores/auth.svelte";
import { conversations } from "$lib/stores/conversations.svelte";
import { health } from "$lib/stores/health.svelte";
import { hydratePermissions } from "$lib/stores/skill-permissions.svelte";
import { hydrate as hydrateSkills } from "$lib/stores/skills.svelte";
import { ui } from "$lib/stores/ui.svelte";
import { modules } from "$lib/modules/store.svelte";

export const ssr = false;
export const prerender = false;

export const load = async () => {
  if (!auth.hydrated) {
    await adapters.hydrate();
    auth.hydrate();
    await Promise.all([ui.hydrate(), health.probe()]);
    // The per-session orchestrator store hydrates itself on the
    // /sessions/[id] page; the sidebar's session list hydrates here.
    void conversations.hydrate();
    void hydrateSkills();
    void hydratePermissions();
    void modules.hydrate();
  }
  return {};
};
