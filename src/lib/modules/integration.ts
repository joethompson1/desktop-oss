// Bridges the module registry into the orchestrator turn.
//
// Called from `agent/loop.ts`. For every ENABLED module it merges the module's
// tools into the orchestrator tool set and collects its system-prompt
// fragments — in a single pass over one settings read. Deliberately plain TS:
// it reads enablement straight from the settings table (no runes store) and
// routes panel-open requests through `dock-actions` (no UI import), so the
// agent graph stays importable under the node:test eval harness.

import type { ToolSet } from "ai";

import { getSetting } from "$lib/db/settings";
import {
  discoveredModules,
  isModuleEnabled,
  MODULE_ENABLEMENT_KEY,
} from "./registry";
import { getModuleState, persistModuleState } from "./host";
import { requestOpenPanel } from "./dock-actions";
import type { AppModule } from "./types";

export interface ModuleTurnContext {
  conversationId: string;
  workingDirectory?: string;
  signal?: AbortSignal;
}

export interface ModuleContributions {
  tools: ToolSet;
  promptFragments: string[];
}

async function enabledModules(): Promise<AppModule[]> {
  let enablement: Record<string, boolean> = {};
  try {
    enablement =
      (await getSetting<Record<string, boolean>>(MODULE_ENABLEMENT_KEY)) ?? {};
  } catch {
    // best-effort — treat as "all default"
  }
  return discoveredModules.filter((m) => isModuleEnabled(m, enablement));
}

/** Collect tools + prompt fragments from all enabled modules for this turn. */
export async function getModuleContributions(
  ctx: ModuleTurnContext,
): Promise<ModuleContributions> {
  const tools: ToolSet = {};
  const promptFragments: string[] = [];

  for (const m of await enabledModules()) {
    const state = getModuleState(ctx.conversationId, m);

    if (m.tools) {
      Object.assign(
        tools,
        m.tools({
          conversationId: ctx.conversationId,
          workingDirectory: ctx.workingDirectory,
          signal: ctx.signal,
          state,
          openPanel: () => requestOpenPanel(m.id),
          persistState: () => persistModuleState(ctx.conversationId, m, state),
        }),
      );
    }

    if (m.promptFragment) {
      const fragment = await m.promptFragment({
        conversationId: ctx.conversationId,
        workingDirectory: ctx.workingDirectory,
        state,
      });
      if (fragment && fragment.trim()) promptFragments.push(fragment.trim());
    }
  }

  return { tools, promptFragments };
}
