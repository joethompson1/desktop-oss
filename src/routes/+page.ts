import { redirect } from "@sveltejs/kit";
import { auth } from "$lib/stores/auth.svelte";
import { listStartedConversations } from "$lib/db/conversations";

export const load = async ({ parent }) => {
  await parent();
  if (!auth.hasToken) {
    throw redirect(307, "/settings");
  }
  // `/` is just an entry point. Land in the most-recent *started* session
  // (one with messages); if there are none, open a fresh draft. We never
  // auto-create an empty session — a draft only persists (and appears in the
  // sidebar) on its first message.
  const started = await listStartedConversations();
  throw redirect(
    307,
    started[0] ? `/sessions/${started[0].id}` : "/sessions/new",
  );
};
