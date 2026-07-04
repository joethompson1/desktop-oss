import { test } from "node:test";
import assert from "node:assert/strict";

import { CHORD_LIBRARY, findChordShape, transposeShape, CAGED_SHAPE_NAMES, type ChordShape } from "./chord-library";
import { noteAt } from "./notes";

function expectResolved(result: ChordShape | { error: string }): ChordShape {
  assert.ok(!("error" in result), "error" in result ? result.error : undefined);
  return result as ChordShape;
}

test("every chord shape's fretted notes are real chord tones, and the root actually sounds", () => {
  for (const [name, shape] of Object.entries(CHORD_LIBRARY)) {
    const soundedNotes = shape.frets
      .map((fret, i) => (fret === null ? null : noteAt(i + 1, fret)))
      .filter((n): n is string => n !== null);

    for (const [i, fret] of shape.frets.entries()) {
      if (fret === null) continue;
      const note = noteAt(i + 1, fret);
      assert.ok(
        shape.tones.includes(note),
        `${name}: string ${i + 1} fret ${fret} sounds ${note}, not in tones [${shape.tones.join(", ")}]`,
      );
    }

    assert.ok(
      soundedNotes.includes(shape.root),
      `${name}: declared root ${shape.root} never actually sounds in the shape`,
    );
  }
});

test("findChordShape is case-insensitive", () => {
  assert.equal(findChordShape("c"), CHORD_LIBRARY.C);
  assert.equal(findChordShape("EM"), CHORD_LIBRARY.Em);
  assert.equal(findChordShape("nonexistent"), undefined);
});

test("transposeShape matches known real-world barre-chord voicings", () => {
  const CMAJOR_TONES = new Set(["C", "E", "G"]);

  // C major, E-shape barre — the textbook 8th-fret barre chord.
  const eShapeC = expectResolved(transposeShape("E", "C"));
  assert.deepEqual(eShapeC.frets, [8, 8, 9, 10, 10, 8]);
  assert.equal(eShapeC.root, "C");
  assert.deepEqual(new Set(eShapeC.tones), CMAJOR_TONES);

  // C major, A-shape barre — the textbook 3rd-fret barre chord (x35553, low E muted).
  const aShapeC = expectResolved(transposeShape("A", "C"));
  assert.deepEqual(aShapeC.frets, [3, 5, 5, 5, 3, null]);
  assert.equal(aShapeC.root, "C");
  assert.deepEqual(new Set(aShapeC.tones), CMAJOR_TONES);

  // Shifting a shape to its OWN root is a no-op.
  const eShapeE = expectResolved(transposeShape("E", "E"));
  assert.deepEqual(eShapeE.frets, CHORD_LIBRARY.E.frets);
});

test("transposeShape: every shape at every one of the 12 roots stays tone-correct and in range", () => {
  const ALL_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  for (const shapeName of CAGED_SHAPE_NAMES) {
    for (const targetRoot of ALL_ROOTS) {
      const resolved = transposeShape(shapeName, targetRoot);
      if ("error" in resolved) continue; // off the fretboard for this shape/root pair — fine
      for (const [i, fret] of resolved.frets.entries()) {
        if (fret === null) continue;
        const note = noteAt(i + 1, fret);
        assert.ok(
          resolved.tones.includes(note),
          `${shapeName}-shape at ${targetRoot}: string ${i + 1} fret ${fret} sounds ${note}, not in tones [${resolved.tones.join(", ")}]`,
        );
      }
      assert.equal(resolved.root, targetRoot);
    }
  }
});

test("transposeShape rejects an unrecognized root", () => {
  const resolved = transposeShape("E", "H");
  assert.ok("error" in resolved);
});
