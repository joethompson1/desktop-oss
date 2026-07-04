// Per-conversation Fretboard state — shared by the panel and the module's
// tools (the agent -> panel channel). Must be runes-backed so a tool's
// mutation re-renders the mounted panel live.
//
// Two display modes: a single chord/scale (`set`), or a progression — an
// ordered run of steps the user flips through at their own pace via the
// panel's stepper (`setProgression` + `goToStep`). `markers`/`caption`
// always reflect whichever is current, so Panel.svelte only ever reads
// those two regardless of mode.

import type { FretboardMarker } from "./geometry";

export type { FretboardMarker };

export interface ProgressionStep {
  markers: FretboardMarker[];
  /** This step's own label, e.g. a chord name — shown in the stepper chip
   *  and the "step N of M" line. */
  caption?: string;
}

export interface FretboardSnapshot {
  markers: FretboardMarker[];
  caption: string;
  progression: ProgressionStep[];
  progressionName: string;
  stepIndex: number;
}

export class FretboardState {
  #markers = $state<FretboardMarker[]>([]);
  #caption = $state<string>("");
  #progression = $state<ProgressionStep[]>([]);
  #progressionName = $state<string>("");
  #stepIndex = $state<number>(0);

  get markers(): FretboardMarker[] {
    return this.#progression.length > 0
      ? (this.#progression[this.#stepIndex]?.markers ?? [])
      : this.#markers;
  }

  get caption(): string {
    return this.#progression.length > 0 ? this.#stepCaption() : this.#caption;
  }

  get progression(): ProgressionStep[] {
    return this.#progression;
  }

  get progressionName(): string {
    return this.#progressionName;
  }

  get stepIndex(): number {
    return this.#stepIndex;
  }

  #stepCaption(): string {
    const title =
      this.#progressionName ||
      this.#progression.map((s) => s.caption || "?").join(" → ");
    const step = this.#progression[this.#stepIndex];
    const stepLabel = step?.caption ? `: ${step.caption}` : "";
    return `${title} — step ${this.#stepIndex + 1}/${this.#progression.length}${stepLabel}`;
  }

  /** Show a single chord/scale. Leaves progression mode. */
  set(markers: FretboardMarker[], caption?: string): void {
    this.#markers = markers;
    // Reset unconditionally: an uncaptioned call (e.g. a bare `notes` diagram)
    // must NOT inherit the previous diagram's title, or an A-scale could
    // render under a stale "C" heading. Consistent with resetting the
    // progression fields below.
    this.#caption = caption ?? "";
    this.#progression = [];
    this.#progressionName = "";
    this.#stepIndex = 0;
  }

  /** Show an ordered run of steps (a progression/drill), starting at step 0. */
  setProgression(steps: ProgressionStep[], name?: string): void {
    this.#progression = steps;
    this.#progressionName = name ?? "";
    this.#stepIndex = 0;
  }

  /** Move the stepper to `index`, clamped into range. No-op outside progression mode. */
  goToStep(index: number): void {
    if (this.#progression.length === 0) return;
    this.#stepIndex = Math.max(0, Math.min(this.#progression.length - 1, index));
  }

  clear(): void {
    this.#markers = [];
    this.#caption = "";
    this.#progression = [];
    this.#progressionName = "";
    this.#stepIndex = 0;
  }

  /** Raw underlying state for persistence — unlike the public `markers`/
   *  `caption` getters, this doesn't collapse progression mode into a
   *  single combined view, so a reload can restore the stepper exactly
   *  where it was. */
  toSnapshot(): FretboardSnapshot {
    return {
      markers: this.#markers,
      caption: this.#caption,
      progression: this.#progression,
      progressionName: this.#progressionName,
      stepIndex: this.#stepIndex,
    };
  }

  applySnapshot(snapshot: FretboardSnapshot): void {
    this.#markers = snapshot.markers;
    this.#caption = snapshot.caption;
    this.#progression = snapshot.progression;
    this.#progressionName = snapshot.progressionName;
    this.#stepIndex = Math.max(
      0,
      Math.min(snapshot.progression.length - 1, snapshot.stepIndex),
    );
  }
}
