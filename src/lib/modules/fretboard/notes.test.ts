import { test } from "node:test";
import assert from "node:assert/strict";

import { noteAt, normalizeNoteName } from "./notes";

test("noteAt: open strings match standard tuning EADGBE", () => {
  assert.equal(noteAt(1, 0), "E"); // high E
  assert.equal(noteAt(2, 0), "B");
  assert.equal(noteAt(3, 0), "G");
  assert.equal(noteAt(4, 0), "D");
  assert.equal(noteAt(5, 0), "A");
  assert.equal(noteAt(6, 0), "E"); // low E
});

test("noteAt: fretted notes wrap correctly through the chromatic scale", () => {
  assert.equal(noteAt(5, 3), "C"); // A string, 3rd fret
  assert.equal(noteAt(6, 3), "G"); // low E, 3rd fret
  assert.equal(noteAt(2, 1), "C"); // B string, 1st fret
  assert.equal(noteAt(4, 12), "D"); // octave up wraps back to D
});

test("normalizeNoteName: case-insensitive and maps flats to canonical sharps", () => {
  assert.equal(normalizeNoteName("c"), "C");
  assert.equal(normalizeNoteName("F#"), "F#");
  assert.equal(normalizeNoteName("db"), "C#");
  assert.equal(normalizeNoteName("Bb"), "A#");
  assert.equal(normalizeNoteName("  a  "), "A");
});

test("normalizeNoteName: unrecognized input returns null", () => {
  assert.equal(normalizeNoteName("H"), null);
  assert.equal(normalizeNoteName(""), null);
});
