// Pure layout math for the fretboard SVG. Kept free of Svelte/runes so it can
// be unit-tested under plain node:test (see geometry.test.ts) and shared by
// Panel.svelte for rendering — the neck is drawn vertically (nut at top,
// frets descending) so it fits the narrow, tall right-dock panel the way a
// chord chart does, with the muted/open row sitting directly above the nut.

export interface FretboardMarker {
  /** Standard tab numbering: 1 = high E (rightmost string) … 6 = low E
   *  (leftmost string). */
  string: number;
  /** 0 = open string. */
  fret: number;
  /** Text shown inside the marker (note name, finger number, interval, …). */
  label?: string;
  /** Highlight as a root note. */
  root?: boolean;
}

export const STRING_COUNT = 6;
export const FRET_COUNT = 14;
export const INLAY_FRETS = [3, 5, 7, 9, 12];

export interface FretboardDims {
  width: number;
  height: number;
  marginX: number;
  nutY: number;
  bottomMargin: number;
}

export const DEFAULT_DIMS: FretboardDims = {
  width: 260,
  height: 520,
  marginX: 24,
  nutY: 52,
  bottomMargin: 24,
};

/** Horizontal gap between adjacent string lines. */
export function stringGap(dims: FretboardDims): number {
  return (dims.width - 2 * dims.marginX) / (STRING_COUNT - 1);
}

/** x of string `n` (1 = high E, rightmost … 6 = low E, leftmost — standard
 *  tab numbering; the visual layout still puts low E on the left, matching
 *  every real chord chart). */
export function stringX(n: number, dims: FretboardDims): number {
  return dims.marginX + (STRING_COUNT - n) * stringGap(dims);
}

/** Vertical gap between adjacent fret lines. */
export function fretGap(dims: FretboardDims): number {
  return (dims.height - dims.nutY - dims.bottomMargin) / FRET_COUNT;
}

/** y of the fret line at the bottom of fret `n` (n=0 is the nut itself). */
export function fretLineY(n: number, dims: FretboardDims): number {
  return dims.nutY + n * fretGap(dims);
}

/** y of the vertical center of fret cell `n` — where markers/labels sit.
 *  `n=0` resolves to the strip above the nut, used for open-string markers
 *  and the muted-string "×". */
export function fretCenterY(n: number, dims: FretboardDims): number {
  return fretLineY(n - 0.5, dims);
}

/** x of the neck's centerline, between strings 3 and 4 — where inlay dots
 *  sit. */
export function centerX(dims: FretboardDims): number {
  return (stringX(3, dims) + stringX(4, dims)) / 2;
}

/** The open-string (fret 0) marker for a string, if any. */
export function openMarker(
  markers: FretboardMarker[],
  stringNum: number,
): FretboardMarker | undefined {
  return markers.find((m) => m.string === stringNum && m.fret === 0);
}

/** A string with no markers at all reads as muted in the above-the-nut row. */
export function isMuted(markers: FretboardMarker[], stringNum: number): boolean {
  return !markers.some((m) => m.string === stringNum);
}

/** Fretted (non-open) markers, ready to plot on the neck body. */
export function frettedMarkers(markers: FretboardMarker[]): FretboardMarker[] {
  return markers.filter((m) => m.fret > 0);
}
