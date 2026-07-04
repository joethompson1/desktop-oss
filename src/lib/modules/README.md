# Modules — the plug-and-play harness

A **module** is a self-contained feature that drops into the app with **no
edits to any core file**. It may contribute any subset of:

- a **right-dock panel** (a UI surface on the right of the window),
- an **input accessory** (UI in the bar above the prompt input, next to the
  working-directory chip),
- **per-conversation reactive state** (shared between the panel and the agent),
- **orchestrator tools** (so the agent can do things / drive the panel),
- **system-prompt wording** (so the agent knows the capability exists).

The registry auto-discovers modules via `import.meta.glob`. To add one, create
a folder and `export default` a module. To remove one, delete the folder — the
panel, tool, and prompt text vanish together and the app reflows untouched.

> This harness is intentionally generic. The fretboard / terminal / file-tree
> ideas are just example modules a separate agent will build later. Nothing
> here is specific to any of them.

## Folder layout

```
src/lib/modules/
  <your-id>/
    index.ts          ← export default defineModule({...})
    Panel.svelte      ← (optional) the right-dock panel UI
    state.svelte.ts   ← (optional) runes-backed per-conversation state
```

The folder name is the module `id`. It namespaces the panel, the settings key,
and — by convention — the module's tool names.

## Minimal example (panel only, no agent)

```ts
// src/lib/modules/notes/index.ts
import { defineModule } from "$lib/modules/types";
import Panel from "./Panel.svelte";

export default defineModule({
  id: "notes",
  label: "Notes",
  icon: "📝",
  panel: { title: "Notes", component: Panel },
});
```

```svelte
<!-- src/lib/modules/notes/Panel.svelte -->
<script lang="ts">
  let { conversationId }: { state: unknown; conversationId: string } = $props();
</script>
<p>Notes for {conversationId}</p>
```

That's a complete module. A rail button appears on the right; clicking it opens
the panel; the chat reflows to make room.

## Full example (agent-driven panel with shared state)

State **must** live in a `.svelte.ts` file so that a tool's mutation reactively
updates the panel.

```ts
// src/lib/modules/example/state.svelte.ts
export class ExampleState {
  markers = $state<string[]>([]);
  set(markers: string[]) { this.markers = markers; }
}
```

```ts
// src/lib/modules/example/index.ts
import { tool } from "ai";
import { z } from "zod";
import { defineModule } from "$lib/modules/types";
import Panel from "./Panel.svelte";
import { ExampleState } from "./state.svelte";

export default defineModule<ExampleState>({
  id: "example",
  label: "Example",
  icon: "🎯",
  createState: () => new ExampleState(),
  panel: { title: "Example", component: Panel },

  // execute() runs in the webview — mutate state + open the panel directly.
  tools: ({ state, openPanel }) => ({
    example_set: tool({
      description: "Display the given markers in the Example panel.",
      inputSchema: z.object({ markers: z.array(z.string()) }),
      execute: async ({ markers }) => {
        state.set(markers);
        openPanel();
        return `Showing ${markers.length} marker(s).`;
      },
    }),
  }),

  // Injected into the system prompt only while the module is enabled.
  promptFragment: () =>
    "## Example panel\nCall `example_set` to display markers in the Example panel on the right.",
});
```

```svelte
<!-- src/lib/modules/example/Panel.svelte -->
<script lang="ts">
  import type { ExampleState } from "./state.svelte";
  let { state }: { state: ExampleState; conversationId: string } = $props();
</script>
<ul>
  {#each state.markers as m}<li>{m}</li>{/each}
</ul>
```

## The contract (`types.ts`)

| Field | Purpose |
|---|---|
| `id` | unique; folder name; namespaces everything the module owns |
| `label` | tooltip / settings name |
| `icon` | rail glyph (emoji or 1–2 chars); falls back to first letter of `label` |
| `description` | one-line summary shown in Settings → Modules (and a future store) |
| `version` / `author` / `repository` | publishing metadata — advisory today, captured for a future module registry / "app store"; `repository` anchors a git-linked store |
| `permissions` | `ModulePermission[]` the module declares it needs (advisory today, not enforced) |
| `enabledByDefault` | defaults to `true` |
| `defaultEnabled()` | capability probe run ONCE when the user has never toggled the module (e.g. "is git installed?"); the result is persisted as the initial enablement. Falls back to `enabledByDefault` if it throws |
| `createState()` | per-conversation runes state, shared by panel + tools |
| `panel` | `{ title?, component }` — the right-dock UI; props: `{ state, conversationId }` |
| `inputAccessory` | `{ component }` — rendered in the bar above the prompt input, after the folder chip; props: `{ state, conversationId, workingDirectory }` (`conversationId` is `""` on a draft session). Only rendered while a working directory is set. See `git/` for a real example |
| `tools(ctx)` | returns a Vercel-AI-SDK `ToolSet`; `ctx` has `state`, `openPanel()`, `conversationId`, `workingDirectory`, `signal` |
| `promptFragment(ctx)` | markdown appended to the system prompt while enabled |
| `settings` | (optional) a settings panel component |

## Publishing metadata (forward-looking)

`version` / `author` / `repository` / `description` / `permissions` are optional
and **advisory today** — nothing enforces them. They exist so a future module
registry / "app store" (and remotely-installed modules from their own git repos)
has the metadata it needs, with `repository` as the git anchor. `MODULE_API_VERSION`
in `types.ts` versions the host contract so a future runtime-loaded module can
check compatibility. New capabilities a module needs should be declared in
`permissions` and, in future, gated through a consent layer rather than handed
raw `invoke` access.

## Conventions & rules

1. **Namespace tool names** with the module id (`fretboard_set`, not `set`) to
   avoid collisions with built-in tools or other modules.
2. **State must be runes** (`$state` in a `.svelte.ts` file). Plain objects
   won't make the panel react to tool mutations.
3. **Panels render only on conversation routes** (`/sessions/[id]`,
   `/conversations/[id]`) — `conversationId` is always set when a panel mounts.
4. **Tools run in the webview** (the orchestrator loop), so `execute()` may
   touch the DOM/stores. Delegates run in a separate process and can't — a
   module tool is orchestrator-only by design.
5. **No core edits.** Don't import your module from `loop.ts`, `+layout.svelte`,
   etc. Discovery is automatic. If you find yourself editing a core file, the
   harness is missing a seam — flag it rather than working around it.
6. **Keep "Clive" out of new code** — the app is being renamed; use neutral
   names.

## How it wires in (for maintainers)

- `registry.ts` — `import.meta.glob` discovery (+ node-safe guard) and the
  shared enablement helper.
- `store.svelte.ts` — UI-side enablement store (settings tab + dock reactivity).
- `host.ts` — per-conversation state cache shared by panel and tools.
- `integration.ts` — agent-side: merges enabled modules' tools + prompt
  fragments into the turn (`loop.ts` calls `getModuleContributions`). Plain TS,
  no runes/UI, so the agent graph stays importable under the eval harness.
- `dock-actions.ts` — lets a tool open a panel without importing the UI store.
- `RightDock.svelte` — the rail + panel host (mounted by `+layout.svelte`).
