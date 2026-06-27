// Per-directory git/GitHub status, computed locally by the `repo_status`
// Rust command (which shells out to git + gh). Cached by working directory
// so sessions sharing a folder share one fetch / one `gh` call, with a
// staleness guard so reactive reads don't spam `gh`.

import { invoke } from "@tauri-apps/api/core";

export interface PrInfo {
  state: "OPEN" | "MERGED" | "CLOSED" | (string & {});
  number: number;
  url: string;
  additions: number | null;
  deletions: number | null;
  isDraft: boolean;
}

export interface RepoStatus {
  isRepo: boolean;
  repository: string | null;
  branch: string | null;
  baseBranch: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  pr: PrInfo | null;
  ghAvailable: boolean;
  error: string | null;
}

interface RawPr {
  state: string;
  number: number;
  url: string;
  additions: number | null;
  deletions: number | null;
  is_draft: boolean;
}

interface RawStatus {
  is_repo: boolean;
  repository: string | null;
  branch: string | null;
  base_branch: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  pr: RawPr | null;
  gh_available: boolean;
  error: string | null;
}

function fromRaw(r: RawStatus): RepoStatus {
  return {
    isRepo: r.is_repo,
    repository: r.repository,
    branch: r.branch,
    baseBranch: r.base_branch,
    dirty: r.dirty,
    ahead: r.ahead,
    behind: r.behind,
    pr: r.pr
      ? {
          state: r.pr.state as PrInfo["state"],
          number: r.pr.number,
          url: r.pr.url,
          additions: r.pr.additions,
          deletions: r.pr.deletions,
          isDraft: r.pr.is_draft,
        }
      : null,
    ghAvailable: r.gh_available,
    error: r.error,
  };
}

// `gh pr view` is a network call — don't recompute a directory's status more
// than once per this window even if many reactive reads ask for it.
const STALE_MS = 30_000;

class RepoStatusStore {
  #byDir = $state<Record<string, { status: RepoStatus; fetchedAt: number }>>(
    {},
  );
  #inflight = new Set<string>();

  /** Reactive read. Returns null until the first fetch for `dir` resolves. */
  statusFor(dir: string | null | undefined): RepoStatus | null {
    if (!dir) return null;
    return this.#byDir[dir]?.status ?? null;
  }

  /** Fetch (or refresh) one directory. No-op if a fresh entry exists and
   *  `force` is false, or if a fetch for this dir is already in flight. */
  async refresh(dir: string, force = false): Promise<void> {
    if (!dir) return;
    const entry = this.#byDir[dir];
    if (!force && entry && Date.now() - entry.fetchedAt < STALE_MS) return;
    if (this.#inflight.has(dir)) return;
    this.#inflight.add(dir);
    try {
      const raw = await invoke<RawStatus>("repo_status", { path: dir });
      this.#byDir = {
        ...this.#byDir,
        [dir]: { status: fromRaw(raw), fetchedAt: Date.now() },
      };
    } catch {
      // Leave any previous value in place; a transient invoke failure
      // shouldn't blank the UI. The next poll retries.
    } finally {
      this.#inflight.delete(dir);
    }
  }

  /** Refresh every unique directory (the sidebar's sessions). Cheap when
   *  entries are fresh thanks to the staleness guard. */
  async refreshAll(dirs: Array<string | null>, force = false): Promise<void> {
    const unique = [...new Set(dirs.filter((d): d is string => !!d))];
    await Promise.all(unique.map((d) => this.refresh(d, force)));
  }

  reset(): void {
    this.#byDir = {};
    this.#inflight.clear();
  }
}

export const repoStatus = new RepoStatusStore();
