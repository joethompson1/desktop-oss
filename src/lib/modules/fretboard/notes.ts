// Pure standard-tuning (EADGBE) note-name math. Kept separate from
// geometry.ts (pixel layout only) so the tool can compute labels/roots
// itself instead of asking the agent to spell out note names for every
// marker — cuts the tool's input size and removes a class of "agent
// computed the wrong note" errors. Also backs chord-library.ts's
// self-verification (every shape's fretted notes are checked against its
// expected chord tones).

const CHROMATIC = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/** Canonical sharp note name → its position in the chromatic scale.
 *  Exported for chord-library.ts's shape-transposition math. */
export const NOTE_INDEX: Record<string, number> = Object.fromEntries(
  CHROMATIC.map((note, i) => [note, i]),
);

// Open string note index into CHROMATIC. Standard tab numbering: 1 = high E
// (thinnest) … 6 = low E (thickest).
const OPEN_STRING_INDEX: Record<number, number> = {
  1: 4, // E
  2: 11, // B
  3: 7, // G
  4: 2, // D
  5: 9, // A
  6: 4, // E
};

/** Note name sounded by fretting `string` at `fret`, standard tuning. */
export function noteAt(string: number, fret: number): string {
  const openIndex = OPEN_STRING_INDEX[string];
  return CHROMATIC[(openIndex + fret) % 12];
}

const FLAT_TO_SHARP: Record<string, string> = {
  Db: "C#",
  Eb: "D#",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
};

/** Normalizes a note name (case, flats) to CHROMATIC's canonical sharp
 *  spelling, or null if unrecognized. */
export function normalizeNoteName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const letter = trimmed[0].toUpperCase();
  const accidental = trimmed.slice(1).replace(/[^#b]/g, "");
  const candidate = letter + accidental;
  if (CHROMATIC.includes(candidate)) return candidate;
  return FLAT_TO_SHARP[letter + accidental] ?? null;
}
