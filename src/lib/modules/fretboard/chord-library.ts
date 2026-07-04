// A small table of verified open-position chord shapes, looked up BY NAME
// instead of asking the agent to recall/compute fret numbers. This mirrors
// what github.com/.../guitar-tutor found the hard way: LLMs are unreliable
// at emitting raw fret arrays from memory (their own example — for "C
// major" the model produced frets reading as `3 2 0 1 0 x`, when the real
// shape is `x 3 2 0 1 0`). A verified lookup table sidesteps that failure
// mode entirely for the common case; `notes` (see index.ts) remains the
// fallback for anything not in this table.
//
// Every entry is cross-checked in chord-library.test.ts: each fretted
// string's note (via notes.ts's noteAt) must be one of `tones`, and `root`
// must actually sound somewhere in the shape. That test is what caught a
// transcription slip in an earlier draft of the G shape below (B string
// was fretted at 2 instead of left open) — computing the actual note from
// the fret number and comparing it against music theory catches mistakes
// that "does this look like the shape I remember" doesn't.

import { noteAt, normalizeNoteName, NOTE_INDEX } from "./notes";

export interface ChordShape {
  /** Fret per string, index 0 = string 1 (high E) … index 5 = string 6 (low
   *  E) — standard tab numbering. `null` = muted (don't play this string). */
  frets: (number | null)[];
  /** Root note name (canonical sharp spelling). */
  root: string;
  /** Expected chord tones (canonical sharp spelling) — used only by the
   *  self-check test, not read at runtime. */
  tones: string[];
}

export const CHORD_LIBRARY: Record<string, ChordShape> = {
  E: { frets: [0, 0, 1, 2, 2, 0], root: "E", tones: ["E", "G#", "B"] },
  Em: { frets: [0, 0, 0, 2, 2, 0], root: "E", tones: ["E", "G", "B"] },
  E7: { frets: [0, 0, 1, 0, 2, 0], root: "E", tones: ["E", "G#", "B", "D"] },
  A: { frets: [0, 2, 2, 2, 0, null], root: "A", tones: ["A", "C#", "E"] },
  Am: { frets: [0, 1, 2, 2, 0, null], root: "A", tones: ["A", "C", "E"] },
  A7: { frets: [0, 2, 0, 2, 0, null], root: "A", tones: ["A", "C#", "E", "G"] },
  D: { frets: [2, 3, 2, 0, null, null], root: "D", tones: ["D", "F#", "A"] },
  Dm: { frets: [1, 3, 2, 0, null, null], root: "D", tones: ["D", "F", "A"] },
  D7: { frets: [2, 1, 2, 0, null, null], root: "D", tones: ["D", "F#", "A", "C"] },
  G: { frets: [3, 0, 0, 0, 2, 3], root: "G", tones: ["G", "B", "D"] },
  G7: { frets: [1, 0, 0, 0, 2, 3], root: "G", tones: ["G", "B", "D", "F"] },
  C: { frets: [0, 1, 0, 2, 3, null], root: "C", tones: ["C", "E", "G"] },
  C7: { frets: [0, 1, 3, 2, 3, null], root: "C", tones: ["C", "E", "G", "A#"] },
  F: { frets: [1, 1, 2, 3, 3, 1], root: "F", tones: ["F", "A", "C"] },
  B7: { frets: [2, 0, 2, 1, 2, null], root: "B", tones: ["B", "D#", "F#", "A"] },
};

/** Case-insensitive lookup, e.g. "c" or "C" both resolve to the "C" entry. */
export function findChordShape(name: string): ChordShape | undefined {
  const trimmed = name.trim();
  if (trimmed in CHORD_LIBRARY) return CHORD_LIBRARY[trimmed];
  const match = Object.keys(CHORD_LIBRARY).find(
    (key) => key.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ? CHORD_LIBRARY[match] : undefined;
}

// ─── Moveable (CAGED) shapes ───────────────────────────────────────────────
// A barre chord — "C major, E-shape, 8th fret" — isn't a different chord,
// it's one of these 5 open shapes slid up the neck: every fret shifts by
// the same amount (a barre stands in for the nut), muted strings stay
// muted. That shift is exact arithmetic, not something to ask an agent to
// recall — the same reasoning as chord-library.ts's fixed shapes, extended
// to any root instead of one hardcoded chord name. Without this, asking for
// "C major, but as a barre chord" has no correct answer except falling back
// to `notes` and hoping the agent remembers the right frets.

export const CAGED_SHAPE_NAMES = ["C", "A", "G", "E", "D"] as const;
export type CagedShapeName = (typeof CAGED_SHAPE_NAMES)[number];

const MAX_FRET = 14;

/** Transpose one of the 5 CAGED open-major shapes so its root lands on
 *  `targetRoot` (e.g. shape "E", root "C" → the classic C barre at the 8th
 *  fret). Returns an error if `targetRoot` isn't a recognized note name or
 *  the shift pushes any string past the fretboard's range. */
export function transposeShape(
  shape: CagedShapeName,
  targetRoot: string,
): ChordShape | { error: string } {
  const base = CHORD_LIBRARY[shape];
  const root = normalizeNoteName(targetRoot);
  if (!root) return { error: `Unrecognized root note "${targetRoot}".` };

  const shift = (NOTE_INDEX[root] - NOTE_INDEX[base.root] + 12) % 12;
  const frets = base.frets.map((f) => (f === null ? null : f + shift));
  if (frets.some((f) => f !== null && f > MAX_FRET)) {
    return { error: `"${shape}"-shape at root "${targetRoot}" needs a fret beyond ${MAX_FRET} — out of range.` };
  }

  const tones = [
    ...new Set(
      frets
        .map((f, i) => (f === null ? null : noteAt(i + 1, f)))
        .filter((n): n is string => n !== null),
    ),
  ];
  return { frets, root, tones };
}
