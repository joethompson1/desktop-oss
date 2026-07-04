// Fretboard module: lets the orchestrator draw chords, scales, and riffs as
// finger positions on a guitar-neck panel. No new Rust needed — the panel is
// pure SVG driven by per-conversation state (see state.svelte.ts).
//
// Note names and root highlighting are computed deterministically (notes.ts)
// rather than asked of the agent, and common chords are resolved from a
// verified shape table (chord-library.ts) rather than trusting the agent's
// recall of fret numbers — both cut the tool's input size and remove classes
// of "agent got the music theory wrong" errors. See chord-library.ts's
// top comment for the concrete failure mode this avoids.

import { tool } from "ai";
import { z } from "zod";
import { defineModule } from "../types";
import { FretboardState, type FretboardMarker, type ProgressionStep } from "./state.svelte";
import Panel from "./Panel.svelte";
import { noteAt, normalizeNoteName } from "./notes";
import {
  findChordShape,
  CHORD_LIBRARY,
  CAGED_SHAPE_NAMES,
  transposeShape,
} from "./chord-library";

const noteInputSchema = z.object({
  string: z
    .number()
    .int()
    .min(1)
    .max(6)
    .describe(
      "String number, standard tab numbering: 1=high E, 2=B, 3=G, 4=D, 5=A, 6=low E.",
    ),
  fret: z
    .number()
    .int()
    .min(0)
    .max(14)
    .describe("Fret number; 0 = open string."),
  label: z
    .string()
    .optional()
    .describe(
      "Override the auto-computed note name shown inside the marker, e.g. a " +
        "finger number or scale degree like \"b3\". Usually omit this.",
    ),
});

const CHORD_NAMES = Object.keys(CHORD_LIBRARY).join(", ");

const showInputSchema = z.object({
  chord: z
    .string()
    .optional()
    .describe(
      `A common chord name to render from a verified fingering table ` +
        `(exact frets guaranteed correct — strongly prefer this over ` +
        `\`notes\` whenever the chord is one of: ${CHORD_NAMES}). This is ` +
        "always the SAME single open-position shape for that name — for a " +
        "barre chord, a different position, or any other voicing of the " +
        "same chord, use `movableShape` instead (reusing `chord` again " +
        "would just render the identical open shape a second time).",
    ),
  movableShape: z
    .object({
      shape: z
        .enum(CAGED_SHAPE_NAMES)
        .describe("Which of the 5 CAGED open-major shapes to use as the movable pattern."),
      root: z
        .string()
        .describe("Target root note (e.g. \"C\", \"F#\") to transpose the shape to."),
    })
    .optional()
    .describe(
      "A moveable barre-chord voicing: one of the 5 CAGED shapes (C/A/G/E/D) " +
        "transposed to any root — e.g. {shape:\"E\", root:\"C\"} for the classic " +
        "C major barre chord at the 8th fret. The fret shift is computed, not " +
        "recalled, so use this for ANY barre chord or higher-position voicing " +
        "instead of guessing frets via `notes`.",
    ),
  notes: z
    .array(noteInputSchema)
    .optional()
    .describe(
      "Explicit string/fret positions — for scales, riffs, or a chord " +
        "not in the verified library. Ignored if `chord` resolves.",
    ),
  root: z
    .string()
    .optional()
    .describe(
      "Root note name (e.g. \"C\", \"F#\"), used to highlight root " +
        "markers when using `notes`. Not needed with `chord`.",
    ),
  caption: z
    .string()
    .optional()
    .describe(
      "Short title shown above the diagram. Defaults to the chord name when using `chord`.",
    ),
});
type ShowInput = z.infer<typeof showInputSchema>;

// Same shape as showInputSchema, minus `caption`: a progression step's label
// is a breadcrumb entry, not a title, and a previous version that let the
// agent freely caption each step produced things like "C Major – Barre (G
// shape, 5th fret)" that overflowed a compact UI no matter how emphatically
// the prompt asked for brevity. Always auto-deriving it (the chord name, or
// "root (shape-shape)" for a movable shape — see resolveShowInput) is the
// only way to guarantee it stays short.
const progressionStepInputSchema = showInputSchema.omit({ caption: true });

const progressionInputSchema = z.object({
  steps: z
    .array(progressionStepInputSchema)
    .min(2)
    .max(8)
    .describe(
      "2-8 steps in playing order, each specified exactly like a single " +
        "`fretboard_show` call (chord/movableShape/notes).",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Optional label for the whole progression, e.g. \"I-IV-V in C\". " +
        "Defaults to the step names joined with arrows.",
    ),
});

// Internal per-marker shape once resolved (label/root filled in) — also
// what's persisted, so it doubles as the hydrateState validator.
const markerSchema = z.object({
  string: z.number().int().min(1).max(6),
  fret: z.number().int().min(0).max(14),
  label: z.string().optional(),
  root: z.boolean().optional(),
});
const progressionStepSchema = z.object({
  markers: z.array(markerSchema),
  caption: z.string().optional(),
});
const snapshotSchema = z.object({
  markers: z.array(markerSchema),
  caption: z.string(),
  progression: z.array(progressionStepSchema),
  progressionName: z.string(),
  stepIndex: z.number().int().min(0),
});

interface Resolved {
  markers: FretboardMarker[];
  caption?: string;
}

function markersFromFrets(frets: (number | null)[], root: string): FretboardMarker[] {
  return frets.flatMap((fret, i) => {
    if (fret === null) return [];
    const note = noteAt(i + 1, fret);
    return [{ string: i + 1, fret, label: note, root: note === root }];
  });
}

// Pure: turns a `fretboard_show` call's arguments into markers. Shared by
// `execute()` (the live call) and `restoreToolCall` (replaying a past call
// when its cockpit entry is clicked) so both agree on exactly one
// resolution path.
function resolveShowInput({ chord, movableShape, notes, root, caption }: ShowInput): Resolved | { error: string } {
  if (movableShape) {
    const resolved = transposeShape(movableShape.shape, movableShape.root);
    if ("error" in resolved) return resolved;
    return {
      markers: markersFromFrets(resolved.frets, resolved.root),
      caption: caption ?? `${movableShape.root} (${movableShape.shape}-shape)`,
    };
  }
  if (chord) {
    const shape = findChordShape(chord);
    if (!shape) {
      return {
        error:
          `Unknown chord "${chord}" — not in the verified library (${CHORD_NAMES}). ` +
          "Omit `chord` and supply exact string/fret positions via `notes` instead.",
      };
    }
    return { markers: markersFromFrets(shape.frets, shape.root), caption: caption ?? chord };
  }
  if (notes && notes.length > 0) {
    const rootNormalized = root ? normalizeNoteName(root) : null;
    const markers = notes.map((n) => {
      const computed = noteAt(n.string, n.fret);
      return {
        string: n.string,
        fret: n.fret,
        label: n.label ?? computed,
        root: rootNormalized !== null && computed === rootNormalized,
      };
    });
    return { markers, caption };
  }
  return { error: "Provide either `chord` (a known chord name) or `notes` (explicit string/fret positions)." };
}

// Pure: resolves every step of a `fretboard_show_progression` call. Shared
// by `execute()` and `restoreToolCall` for the same reason as
// `resolveShowInput`. Bails on the first bad step rather than skipping it —
// a progression with a silently-dropped step would misnumber the rest.
function resolveProgressionSteps(
  steps: ShowInput[],
): ProgressionStep[] | { error: string } {
  const resolved: ProgressionStep[] = [];
  for (const [i, stepInput] of steps.entries()) {
    const result = resolveShowInput(stepInput);
    if ("error" in result) return { error: `Step ${i + 1}: ${result.error}` };
    resolved.push({ markers: result.markers, caption: result.caption });
  }
  return resolved;
}

export default defineModule<FretboardState>({
  id: "fretboard",
  label: "Fretboard",
  icon: "♪",
  createState: () => new FretboardState(),
  serializeState: (state) => state.toSnapshot(),
  hydrateState: (state, snapshot) => {
    const parsed = snapshotSchema.safeParse(snapshot);
    if (parsed.success) state.applySnapshot(parsed.data);
  },
  // Each fretboard_show(_progression) call overwrites `state` wholesale, so
  // clicking an OLDER call's cockpit entry would otherwise just re-open the
  // panel showing whatever a LATER call last set. Replay that specific
  // call's resolution instead — this is a transient view, not a new
  // "current" state, so deliberately doesn't call persistState.
  restoreToolCall: (state, toolName, input) => {
    if (toolName === "fretboard_clear") {
      state.clear();
      return;
    }
    if (toolName === "fretboard_show") {
      const parsed = showInputSchema.safeParse(input);
      if (!parsed.success) return;
      const resolved = resolveShowInput(parsed.data);
      if (!("error" in resolved)) state.set(resolved.markers, resolved.caption);
      return;
    }
    if (toolName === "fretboard_show_progression") {
      const parsed = progressionInputSchema.safeParse(input);
      if (!parsed.success) return;
      const resolved = resolveProgressionSteps(parsed.data.steps);
      if (!("error" in resolved)) state.setProgression(resolved, parsed.data.name);
    }
  },
  panel: { title: "Fretboard", component: Panel },

  tools: ({ state, openPanel, persistState }) => ({
    fretboard_show: tool({
      description:
        "Display a chord, scale, or riff on the Fretboard panel as finger " +
        "positions on a guitar neck. Note names and root highlighting are " +
        "computed automatically from standard tuning — you don't need to " +
        "work them out yourself.",
      inputSchema: showInputSchema,
      execute: async (input) => {
        const resolved = resolveShowInput(input);
        if ("error" in resolved) return resolved.error;
        state.set(resolved.markers, resolved.caption);
        openPanel();
        persistState();
        return (
          `Showing ${resolved.markers.length} marker(s) on the fretboard` +
          (resolved.caption ? ` (${resolved.caption})` : "") +
          "."
        );
      },
    }),
    fretboard_show_progression: tool({
      description:
        "Show an ordered SEQUENCE of chords/voicings (a song's changes, a " +
        "I-IV-V, a chord-change drill) on the Fretboard panel as steps the " +
        "user flips through at their own pace. Prefer this over multiple " +
        "`fretboard_show` calls whenever teaching more than one chord in a " +
        "row. Each step's displayed label is always just its chord name " +
        "(or root note for a movable shape) — there's no way to caption a " +
        "step yourself, so don't try.",
      inputSchema: progressionInputSchema,
      execute: async ({ steps, name }) => {
        const resolved = resolveProgressionSteps(steps);
        if ("error" in resolved) return resolved.error;
        state.setProgression(resolved, name);
        openPanel();
        persistState();
        return (
          `Displayed a ${resolved.length}-step progression on the fretboard` +
          (name ? ` (${name})` : "") +
          `: ${resolved.map((s) => s.caption ?? "?").join(" → ")}.`
        );
      },
    }),
    fretboard_clear: tool({
      description: "Clear the Fretboard panel.",
      inputSchema: z.object({}),
      execute: async () => {
        state.clear();
        persistState();
        return "Cleared the fretboard.";
      },
    }),
  }),

  promptFragment: () =>
    "## Fretboard panel\n" +
    "You have a Fretboard panel on the right. When teaching or demonstrating a " +
    "chord, scale, or riff, call `fretboard_show` so the user sees it on the " +
    "neck. Three ways to specify what to show — pick whichever fits, don't " +
    "guess frets when one of the first two applies:\n" +
    `1. \`chord\` — a common chord name (${CHORD_NAMES}). Always the same single ` +
    "open-position shape for that name.\n" +
    "2. `movableShape` — a barre chord or higher-position voicing: one of the " +
    "5 CAGED shapes (C/A/G/E/D) transposed to any root, e.g. " +
    '{shape:"E", root:"C"} for the classic C major barre at the 8th fret. If ' +
    "asked to show several voicings/positions of the SAME chord (e.g. \"every " +
    "way to play C\"), use a DIFFERENT `movableShape`/`chord` for each one — " +
    "reusing the same `chord` twice renders an identical, indistinguishable " +
    "diagram.\n" +
    "3. `notes` — explicit `{string, fret}` positions, for scales, riffs, or " +
    "a chord/voicing the first two don't cover (standard tab numbering: " +
    "string 1 = high E … 6 = low E; fret 0 = open; a string with no entry " +
    "reads as muted), plus an optional `root` note name to highlight.\n\n" +
    "Note names and root highlighting are always computed for you — never " +
    "work them out yourself.\n\n" +
    "Teaching a song's changes, a I-IV-V, or several voicings in a row? Call " +
    "`fretboard_show_progression` with 2-8 steps (each specified the same " +
    "way as a `fretboard_show` call, minus `caption` — steps don't take one) " +
    "instead of calling `fretboard_show` repeatedly — it gives the user a " +
    "breadcrumb they can step through at their own pace, rather than only " +
    "ever seeing the last one you showed.",
});
