import { open } from "@tauri-apps/plugin-dialog";
import { homeDir } from "$lib/skills/rust";

/**
 * Open the native folder picker. Returns the chosen absolute path, or null
 * if the user cancelled. Defaults to `current` (or the home dir) so the
 * dialog opens somewhere useful.
 */
export async function pickDirectory(current?: string): Promise<string | null> {
  const defaultPath = current || (await homeDir()) || undefined;
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Choose a working directory for this session",
    defaultPath,
  });
  return typeof picked === "string" ? picked : null;
}
