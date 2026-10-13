// What the capture screen tells the rider, derived from the analysis loop (~8 frames per second).
import type { Hint } from "@verify/capture";

/** The message shown: the top hint, or "ready" when the frame is good (auto-capture is counting). */
export type Shown = Hint | "ready";

/** Guide colour: white while looking for the card, amber while something needs fixing, green when good. */
export type Readiness = "searching" | "adjust" | "ready";

export function topMessage(hints: readonly Hint[]): Shown {
  return hints[0] ?? "ready";
}

export function readinessOf(shown: Shown | null): Readiness {
  if (shown === null || shown === "no_document") return "searching";
  return shown === "ready" ? "ready" : "adjust";
}

/** How long "no card found" may last before the screen suggests a plain surface. */
export const SURFACE_TIP_AFTER_MS = 5000;

/**
 * Keeps the message steady: a new message replaces the shown one only after it has been on top for
 * `frames` frames in a row. Without this, a hint flickering between two values would be unreadable
 * and would flood screen readers (the message sits in an aria-live region).
 */
export class HintStabilizer {
  readonly frames: number;
  #shown: Shown | null = null;
  #since = 0;
  #candidate: Shown | null = null;
  #count = 0;

  constructor(frames = 2) {
    this.frames = frames;
  }

  /** Feeds one frame's top message at time `now` (ms); returns the message to show. */
  push(next: Shown, now: number): Shown {
    if (this.#shown === null) {
      this.#show(next, now);
    } else if (next === this.#shown) {
      this.#candidate = null;
      this.#count = 0;
    } else {
      this.#count = next === this.#candidate ? this.#count + 1 : 1;
      this.#candidate = next;
      if (this.#count >= this.frames) this.#show(next, now);
    }
    return this.#shown as Shown;
  }

  /** Milliseconds the current message has been shown, at time `now`. */
  shownFor(now: number): number {
    return this.#shown === null ? 0 : now - this.#since;
  }

  get shown(): Shown | null {
    return this.#shown;
  }

  reset(): void {
    this.#shown = null;
    this.#candidate = null;
    this.#count = 0;
  }

  #show(next: Shown, now: number): void {
    this.#shown = next;
    this.#since = now;
    this.#candidate = null;
    this.#count = 0;
  }
}
