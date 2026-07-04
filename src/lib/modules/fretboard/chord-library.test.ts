import { test } from "node:test";
import assert from "node:assert/strict";

import { CHORD_LIBRARY, findChordShape, transposeShape, CAGED_SHAPE_NAMES, type ChordShape } from "./chord-library";
import { noteAt } from "./notes";

function expectResolved(result: ChordShape | { error: string }): ChordShape {
  assert.ok(!("error" in result), "error" in result ? result.error : undefined);
  return result as ChordShape;
}

test("every chord shape's `tones` equals its sounded notes exactly, and the root sounds", () => {
  for (const [name, shape] of Object.entries(CHORD_LIBRARY)) {
    const soundedNotes = shape.frets
      .map((fret, i) => (fret === null ? null : noteAt(i + 1, fret)))
      .filter((n): n is string => n !== null);
    const sounded = new Set(soundedNotes);
    const declared = new Set(shape.tones);

    // Every sounded note is a declared tone (catches a wrong/mis-transcribed fret).
    for (const note of sounded) {
      assert.ok(
        declared.has(note),
        `${name}: sounds ${note}, not in tones [${shape.tones.join(", ")}]`,
      );
    }
    // …and every declared tone is actually sounded (catches a phantom tone the
    // voicing never plays, e.g. an omitted 5th listed anyway).
    for (const note of declared) {
      assert.ok(
        sounded.has(note),
        `${name}: tones lists ${note} but the shape never sounds it`,
      );
    }

    assert.ok(
      sounded.has(shape.root),
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
      const sounded = resolved.frets
        .map((fret, i) => (fret === null ? null : noteAt(i + 1, fret)))
        .filter((n): n is string => n !== null);
      for (const [i, fret] of resolved.frets.entries()) {
        if (fret === null) continue;
        const note = noteAt(i + 1, fret);
        assert.ok(
          resolved.tones.includes(note),
          `${shapeName}-shape at ${targetRoot}: string ${i + 1} fret ${fret} sounds ${note}, not in tones [${resolved.tones.join(", ")}]`,
        );
      }
      assert.equal(resolved.root, targetRoot);
      // Transposing a major shape must keep the root actually voiced (a
      // dropped root string would otherwise pass the tone check silently).
      assert.ok(
        sounded.includes(targetRoot),
        `${shapeName}-shape at ${targetRoot}: root ${targetRoot} is never voiced`,
      );
    }
  }
});

test("transposeShape rejects an unrecognized root", () => {
  const resolved = transposeShape("E", "H");
  assert.ok("error" in resolved);
});
