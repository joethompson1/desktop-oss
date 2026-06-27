import { redirect } from "@sveltejs/kit";
import { auth } from "$lib/stores/auth.svelte";
import { ensureDefaultSession } from "$lib/db/conversations";

export const load = async ({ parent }) => {
  await parent();
  if (!auth.hasToken) {
    throw redirect(307, "/settings");
  }
  // Sessions are the unit of work now; `/` is just an entry point that
  // lands the user in their most-recent session (creating a default one
  // rooted at the home dir on first launch).
  const id = await ensureDefaultSession();
  throw redirect(307, `/sessions/${id}`);
};
