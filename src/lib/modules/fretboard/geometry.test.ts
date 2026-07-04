import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DIMS,
  FRET_COUNT,
  centerX,
  fretCenterY,
  fretLineY,
  frettedMarkers,
  isMuted,
  openMarker,
  stringX,
  type FretboardMarker,
} from "./geometry";

test("stringX places string 1 (high E) at the right margin and string 6 (low E) at the left margin", () => {
  assert.equal(stringX(1, DEFAULT_DIMS), DEFAULT_DIMS.width - DEFAULT_DIMS.marginX);
  assert.equal(stringX(6, DEFAULT_DIMS), DEFAULT_DIMS.marginX);
});

test("stringX is evenly spaced and centerX sits between strings 3 and 4", () => {
  const gap = stringX(2, DEFAULT_DIMS) - stringX(1, DEFAULT_DIMS);
  for (let n = 2; n <= 6; n++) {
    const thisGap = stringX(n, DEFAULT_DIMS) - stringX(n - 1, DEFAULT_DIMS);
    assert.ok(Math.abs(thisGap - gap) < 1e-9);
  }
  assert.ok(
    Math.abs(
      centerX(DEFAULT_DIMS) -
        (stringX(3, DEFAULT_DIMS) + stringX(4, DEFAULT_DIMS)) / 2,
    ) < 1e-9,
  );
});

test("fretLineY(0) is the nut; fretLineY(FRET_COUNT) is the bottom margin", () => {
  assert.equal(fretLineY(0, DEFAULT_DIMS), DEFAULT_DIMS.nutY);
  assert.equal(
    fretLineY(FRET_COUNT, DEFAULT_DIMS),
    DEFAULT_DIMS.height - DEFAULT_DIMS.bottomMargin,
  );
});

test("fretCenterY(1) sits between the nut and the first fret line", () => {
  const y = fretCenterY(1, DEFAULT_DIMS);
  assert.ok(y > fretLineY(0, DEFAULT_DIMS));
  assert.ok(y < fretLineY(1, DEFAULT_DIMS));
});

test("fretCenterY(0) sits above the nut — the open-string / mute row", () => {
  assert.ok(fretCenterY(0, DEFAULT_DIMS) < DEFAULT_DIMS.nutY);
});

test("openMarker finds only the fret-0 marker on a given string", () => {
  const markers: FretboardMarker[] = [
    { string: 1, fret: 0, root: true },
    { string: 1, fret: 3 },
    { string: 2, fret: 2 },
  ];
  assert.equal(openMarker(markers, 1), markers[0]);
  assert.equal(openMarker(markers, 2), undefined);
  assert.equal(openMarker(markers, 6), undefined);
});

test("isMuted is true only when a string has no markers at all", () => {
  const markers: FretboardMarker[] = [
    { string: 1, fret: 0 },
    { string: 2, fret: 3 },
  ];
  assert.equal(isMuted(markers, 1), false);
  assert.equal(isMuted(markers, 2), false);
  assert.equal(isMuted(markers, 3), true);
});

test("frettedMarkers excludes open strings", () => {
  const markers: FretboardMarker[] = [
    { string: 1, fret: 0 },
    { string: 2, fret: 3 },
    { string: 3, fret: 5 },
  ];
  const fretted = frettedMarkers(markers);
  assert.equal(fretted.length, 2);
  assert.ok(fretted.every((m) => m.fret > 0));
});
