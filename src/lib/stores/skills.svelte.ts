// Skills store — single source of truth for which skills exist on
// disk, who's enabled, and the live fs-watcher subscription. The
// menu (ChatInput) and the Skill tool (Phase 5) read from this.

import { getSetting, setSetting } from "$lib/db/settings";
import { PHASE_1_FIXTURES } from "$lib/skills/fixtures";
import {
  DEFAULT_SOURCE_ENABLEMENT,
  loadAllSkills,
  type SourceEnablement,
} from "$lib/skills/registry";
import { homeDir, joinPath, watchSkillDirs } from "$lib/skills/rust";
import type { Skill, SkillSource } from "$lib/skills/types";

/** True only when we're running inside the Tauri shell — the Rust
 *  commands aren't available in a plain browser preview. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const SETTING_KEY = "skillSourceEnablement";

interface SkillsState {
  all: Skill[];
  loading: boolean;
  error: string | null;
  hydrated: boolean;
  enablement: SourceEnablement;
}

export const skills = $state<SkillsState>({
  all: [],
  loading: false,
  error: null,
  hydrated: false,
  enablement: DEFAULT_SOURCE_ENABLEMENT,
});

let watcherInstalled = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Initial load. Safe to call repeatedly — only the first call
 *  actually triggers discovery; subsequent calls are no-ops. */
export async function hydrate(): Promise<void> {
  if (skills.hydrated) return;
  skills.loading = true;
  try {
    if (!inTauri()) {
      // Browser preview — no Tauri commands. Fall back to fixtures
      // so the menu is still demoable without `npm run tauri:dev`.
      skills.all = PHASE_1_FIXTURES;
      skills.hydrated = true;
      return;
    }
    const stored = await getSetting<SourceEnablement>(SETTING_KEY);
    if (stored) skills.enablement = stored;
    await refresh();
    await installWatcherOnce();
    skills.hydrated = true;
  } catch (err) {
    skills.error = err instanceof Error ? err.message : String(err);
  } finally {
    skills.loading = false;
  }
}

/** Force a discovery rescan. Called from settings ("Rescan now"), at
 *  startup, and after fs-watcher events. */
export async function refresh(): Promise<void> {
  try {
    skills.error = null;
    skills.all = await loadAllSkills(skills.enablement);
  } catch (err) {
    skills.error = err instanceof Error ? err.message : String(err);
    skills.all = [];
  }
}

/** Toggle a single source on/off. Persists, re-runs discovery. */
export async function setSourceEnabled(
  source: SkillSource,
  enabled: boolean,
): Promise<void> {
  skills.enablement = {
    enabled: { ...skills.enablement.enabled, [source]: enabled },
  };
  if (!inTauri()) {
    // Browser-preview path: setSetting + loadAllSkills both require
    // Tauri commands. Apply the enablement filter against fixtures
    // in-memory so the toggle is still visibly demoable.
    skills.all = PHASE_1_FIXTURES.filter(
      (s) => skills.enablement.enabled[s.source],
    );
    return;
  }
  await setSetting(SETTING_KEY, skills.enablement);
  await refresh();
}

async function installWatcherOnce(): Promise<void> {
  if (watcherInstalled) return;
  const home = await homeDir();
  if (!home) return;
  // Watch the parent directory of each known source. Watching the
  // actual skill dirs would miss them when they're created on the
  // fly (e.g. user runs `mkdir ~/.codex/prompts`); watching the
  // dot-dirs catches both cases.
  const roots = [
    joinPath(home, ".claude"),
    joinPath(home, ".cursor"),
    joinPath(home, ".codex"),
    joinPath(home, ".clive"),
  ];
  try {
    await watchSkillDirs(roots, () => scheduleRefresh());
    watcherInstalled = true;
  } catch (err) {
    // Watcher install failure isn't fatal — discovery still works,
    // just not live-updating. Common in browser preview where Tauri
    // commands aren't wired.
    console.warn("[skills] watcher install failed:", err);
  }
}

function scheduleRefresh(): void {
  // Coalesce rapid-fire events (e.g. editor saves that trigger
  // multiple mtime updates) into a single rescan ~200ms later.
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 200);
}
