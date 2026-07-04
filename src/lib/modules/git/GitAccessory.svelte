<script lang="ts">
  // Prompt-bar accessory: repo · base ← head branch pills, PR diff stats,
  // and a PR action button for the current working directory. Owns its own
  // data fetching via the shared repoStatus cache.
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { repoStatus } from "$lib/stores/repo-status.svelte";
  import type { ModuleInputAccessoryProps } from "$lib/modules/types";

  let { workingDirectory }: ModuleInputAccessoryProps = $props();

  $effect(() => {
    if (workingDirectory) void repoStatus.refresh(workingDirectory);
  });

  const status = $derived(repoStatus.statusFor(workingDirectory));

  interface RepoCoords {
    owner: string;
    repo: string;
  }

  function parseRepository(repository: string | null): RepoCoords | null {
    if (!repository) return null;
    const https = repository.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );
    if (https) return { owner: https[1], repo: https[2] };
    const ssh = repository.match(
      /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );
    if (ssh) return { owner: ssh[1], repo: ssh[2] };
    const shorthand = repository.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };
    return null;
  }

  const isRepo = $derived(status?.isRepo ?? false);
  const coords = $derived(parseRepository(status?.repository ?? null));
  const repoShort = $derived(coords?.repo ?? "");
  const baseBranch = $derived(status?.baseBranch ?? "main");
  const headBranch = $derived(status?.branch ?? "");
  const pr = $derived(status?.pr ?? null);

  type Action = { label: string; href: string };

  const action = $derived.by<Action | null>(() => {
    if (!isRepo || !headBranch) return null;
    if (pr?.url) {
      if (pr.state === "MERGED") return { label: "Merged", href: pr.url };
      if (pr.state === "CLOSED") return { label: "Closed", href: pr.url };
      const label = pr.isDraft ? `Draft #${pr.number}` : `View PR #${pr.number}`;
      return { label, href: pr.url };
    }
    if (!coords) return null;
    const compareUrl =
      `https://github.com/${coords.owner}/${coords.repo}` +
      `/compare/${encodeURIComponent(baseBranch)}` +
      `...${encodeURIComponent(headBranch)}?expand=1`;
    return { label: "Create PR", href: compareUrl };
  });

  const showStats = $derived(
    !!pr?.url && pr.additions !== null && pr.deletions !== null,
  );

  async function handleAction() {
    if (!action) return;
    try {
      await openUrl(action.href);
    } catch {
      /* opener unavailable — non-fatal */
    }
  }
</script>

{#if isRepo && headBranch}
  <div class="git-accessory" data-testid="git-accessory">
    <span class="branch-icon" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="5" cy="3" r="1.5" />
        <circle cx="5" cy="13" r="1.5" />
        <circle cx="11" cy="8" r="1.5" />
        <path d="M5 4.5v7" />
        <path d="M5 8h3.5a2 2 0 0 0 2-2V6.5" />
      </svg>
    </span>
    {#if repoShort}
      <span class="repo" title={status?.repository ?? undefined}>{repoShort}</span>
    {/if}
    <span class="flow" data-testid="branch-flow">
      <span class="branch-pill base" title={baseBranch}>{baseBranch}</span>
      <span class="arrow" aria-hidden="true">←</span>
      <span class="branch-pill head" title={headBranch}>{headBranch}</span>
    </span>

    <span class="spacer"></span>

    {#if showStats && pr}
      <span class="stats" data-testid="branch-stats">
        <span class="add">+{pr.additions}</span>
        <span class="del">-{pr.deletions}</span>
      </span>
    {/if}
    {#if action}
      <button
        type="button"
        class="action"
        data-pr-state={pr?.state ?? "none"}
        data-testid="branch-action"
        onclick={handleAction}
        title={action.href}
      >
        {action.label}
      </button>
    {/if}
  </div>
{/if}

<style>
  .git-accessory {
    display: flex;
    align-items: center;
    gap: 0.5em;
    flex: 1 1 auto;
    min-width: 0;
  }
  .branch-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-faint);
    flex: 0 0 auto;
  }
  .repo {
    color: var(--text-muted);
    flex: 0 0 auto;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flow {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    min-width: 0;
    flex: 0 1 auto;
  }
  .branch-pill {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--code-inline-bg);
    font-family: var(--code-mono);
    font-size: 0.92em;
    color: var(--text);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: baseline;
  }
  .branch-pill.base {
    max-width: 110px;
  }
  .branch-pill.head {
    max-width: 220px;
  }
  .arrow {
    color: var(--text-faint);
    flex: 0 0 auto;
  }
  .spacer {
    flex: 1 1 auto;
    min-width: 0.5em;
  }
  .stats {
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    font-family: var(--code-mono);
    font-size: 0.9em;
    flex: 0 0 auto;
  }
  .stats .add {
    color: var(--diff-add-fg, #5fb04f);
  }
  .stats .del {
    color: var(--diff-del-fg, #d75353);
  }
  .action {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    padding: 0.25em 0.55em;
    font-family: inherit;
    font-size: inherit;
    color: var(--text-muted);
    cursor: pointer;
    flex: 0 0 auto;
    transition:
      background-color 0.12s ease,
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .action:hover {
    background: var(--hover-bg);
    color: var(--text);
    border-color: var(--border);
  }
  .action[data-pr-state="MERGED"] {
    color: #8b5cf6;
  }
  .action[data-pr-state="CLOSED"] {
    color: var(--diff-del-fg, #d75353);
  }
  .action[data-pr-state="OPEN"] {
    color: #16a34a;
  }
</style>
