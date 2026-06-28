// Sidebar session store. Sessions (orchestrator conversations, each rooted
// in a working directory) are grouped by directory basename. Each session
// expands to reveal its delegate runs as nested rows. Light polling keeps
// run statuses fresh.

import type { RunSummary } from "$lib/types/run";
import {
  deleteConversation,
  listStartedConversations,
  updateConversationTitle,
  type Conversation,
} from "$lib/db/conversations";
import {
  deleteRun as dbDeleteRun,
  listRunsForConversations,
  markStaleRunsAbandoned,
} from "$lib/db/runs";
import { repoStatus } from "./repo-status.svelte";

/** A run rendered as a sidebar row (nested under its session). */
export interface ConversationCard {
  id: string;
  title: string;
  status: string;
  archived: boolean;
}

export interface SessionCard {
  id: string;
  title: string | null;
  workingDirectory: string;
  updatedAt: number;
  runs: RunSummary[];
}

export interface SessionGroup {
  /** Directory basename used as the group header (e.g. "desktop-oss"). */
  basename: string;
  /** Full working directory path (for the header tooltip). */
  directory: string;
  sessions: SessionCard[];
}

export function basename(dir: string): string {
  const trimmed = (dir ?? "").replace(/\/+$/, "");
  if (!trimmed) return "other";
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) || trimmed : trimmed;
}

/** Map a delegate run to the minimal shape the nested run row renders. */
export function runToCard(run: RunSummary): ConversationCard {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    archived: false,
  };
}

class ConversationsStore {
  #sessions = $state<Conversation[]>([]);
  #runs = $state<Record<string, RunSummary[]>>({});
  #expandedIds = $state<string[]>([]);
  #hydrated = $state<boolean>(false);
  #hydrating = $state<boolean>(false);
  #hydrationError = $state<string | null>(null);
  #pollHandle: number | null = null;

  get hydrated(): boolean {
    return this.#hydrated;
  }
  get hydrating(): boolean {
    return this.#hydrating;
  }
  get hydrationError(): string | null {
    return this.#hydrationError;
  }

  /** Sessions grouped by directory basename, group order following the
   *  most-recently-updated session in each (sessions arrive newest-first). */
  get groups(): SessionGroup[] {
    const groups: SessionGroup[] = [];
    const byKey = new Map<string, SessionGroup>();
    for (const convo of this.#sessions) {
      const dir = convo.workingDirectory ?? "";
      const key = dir || "other";
      let group = byKey.get(key);
      if (!group) {
        group = { basename: basename(dir), directory: dir, sessions: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.sessions.push({
        id: convo.id,
        title: convo.title,
        workingDirectory: dir,
        updatedAt: convo.updatedAt,
        runs: this.#runs[convo.id] ?? [],
      });
    }
    return groups;
  }

  isExpanded(id: string): boolean {
    return this.#expandedIds.includes(id);
  }

  toggleExpanded(id: string): void {
    this.#expandedIds = this.#expandedIds.includes(id)
      ? this.#expandedIds.filter((x) => x !== id)
      : [...this.#expandedIds, id];
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated || this.#hydrating) return;
    this.#hydrating = true;
    try {
      // Any run still PENDING/RUNNING from a previous session is a zombie —
      // its subprocess died when the app closed. Mark them CANCELLED so the
      // sidebar doesn't show forever-spinning rows.
      await markStaleRunsAbandoned();
      await this.#load();
      this.#hydrated = true;
    } catch (err) {
      this.#hydrationError =
        err instanceof Error ? err.message : "Failed to load sessions";
      this.#hydrated = true;
    } finally {
      this.#hydrating = false;
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.#load();
      this.#hydrationError = null;
    } catch (err) {
      this.#hydrationError =
        err instanceof Error ? err.message : "Failed to load sessions";
    }
  }

  async #load(): Promise<void> {
    const sessions = await listStartedConversations();
    const runs = await listRunsForConversations(sessions.map((s) => s.id));
    const byConversation: Record<string, RunSummary[]> = {};
    for (const run of runs) {
      (byConversation[run.conversationId] ??= []).push(run);
    }
    this.#sessions = sessions;
    this.#runs = byConversation;
    // Refresh each session folder's git/PR status (fire-and-forget; the
    // staleness guard keeps this from spamming `gh` on every 3s poll).
    void repoStatus.refreshAll(sessions.map((s) => s.workingDirectory));
  }

  /** Rename a session (the row's "Rename" action). */
  async renameSession(id: string, title: string): Promise<void> {
    await updateConversationTitle(id, title);
    this.#sessions = this.#sessions.map((s) =>
      s.id === id ? { ...s, title } : s,
    );
  }

  /** Hard-delete a session and everything under it (messages + runs). */
  async deleteSession(id: string): Promise<void> {
    await deleteConversation(id);
    this.#sessions = this.#sessions.filter((s) => s.id !== id);
    const { [id]: _dropped, ...rest } = this.#runs;
    this.#runs = rest;
    this.#expandedIds = this.#expandedIds.filter((x) => x !== id);
  }

  /** Hard-delete a single delegate run (the nested row × action). */
  async deleteRun(runId: string): Promise<void> {
    await dbDeleteRun(runId);
    const next: Record<string, RunSummary[]> = {};
    for (const [cid, list] of Object.entries(this.#runs)) {
      next[cid] = list.filter((r) => r.id !== runId);
    }
    this.#runs = next;
  }

  startPolling(): void {
    if (this.#pollHandle !== null) return;
    // Light polling — once a delegate finishes its status changes and the
    // sidebar should reflect it. A few seconds late is fine.
    this.#pollHandle = window.setInterval(() => {
      void this.refresh();
    }, 3000);
  }

  stopPolling(): void {
    if (this.#pollHandle !== null) {
      window.clearInterval(this.#pollHandle);
      this.#pollHandle = null;
    }
  }

  reset(): void {
    this.#sessions = [];
    this.#runs = {};
    this.#expandedIds = [];
    this.#hydrated = false;
    this.#hydrating = false;
    this.#hydrationError = null;
    this.stopPolling();
  }
}

export const conversations = new ConversationsStore();
