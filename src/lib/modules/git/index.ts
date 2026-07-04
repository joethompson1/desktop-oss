// Git module: surfaces the working directory's branch/PR state in the
// prompt-bar accessory, and teaches the orchestrator about it via a prompt
// fragment. Defaults to enabled only when a `git` binary is present.

import { invoke } from "@tauri-apps/api/core";
import { defineModule } from "../types";
import { repoStatus } from "$lib/stores/repo-status.svelte";
import GitAccessory from "./GitAccessory.svelte";

export default defineModule({
  id: "git",
  label: "Git",
  icon: "⎇",
  description:
    "Shows the working directory's branch / PR state and teaches the orchestrator about it.",
  version: "1.0.0",
  author: "desktop-oss",
  permissions: ["run-commands"],
  enabledByDefault: false,
  defaultEnabled: () => invoke<boolean>("git_available"),
  inputAccessory: { component: GitAccessory },
  promptFragment: async ({ workingDirectory }) => {
    if (!workingDirectory) return "";
    await repoStatus.refresh(workingDirectory);
    const s = repoStatus.statusFor(workingDirectory);
    if (!s?.isRepo) return "";
    const lines = [
      "## Git",
      `The working directory is a git repository${s.repository ? ` (${s.repository})` : ""}.`,
      `Current branch: ${s.branch ?? "(detached)"} — base branch: ${s.baseBranch ?? "main"}.` +
        (s.dirty ? " The working tree has uncommitted changes." : ""),
    ];
    if (s.pr) {
      lines.push(
        `PR #${s.pr.number} (${s.pr.state}${s.pr.isDraft ? ", draft" : ""}): ${s.pr.url}`,
      );
    }
    return lines.join("\n");
  },
});
