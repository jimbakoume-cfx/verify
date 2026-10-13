import { describe, expect, it } from "vitest";
import { listenForBack, pushBackGuard } from "./history";

/** A browser history: entries, the current index, and popstate on back(). */
function fakeHistoryWindow() {
  const entries: unknown[] = [null];
  let index = 0;
  const listeners = new Set<() => void>();
  let left = false;
  const history = {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(index + 1, entries.length, state);
      index++;
    },
    back() {
      if (index === 0) {
        left = true;
        return;
      }
      index--;
      listeners.forEach((l) => l());
    },
  };
  const win = {
    history,
    addEventListener: (type: string, l: () => void) => type === "popstate" && listeners.add(l),
    removeEventListener: (type: string, l: () => void) => type === "popstate" && listeners.delete(l),
  };
  return {
    win: win as unknown as Window,
    pressBack: () => history.back(),
    get depth() {
      return entries.length;
    },
    get index() {
      return index;
    },
    get left() {
      return left;
    },
    get listeners() {
      return listeners.size;
    },
  };
}

describe("pushBackGuard", () => {
  it("adds one guard entry, and only one", () => {
    const h = fakeHistoryWindow();
    pushBackGuard(h.win);
    pushBackGuard(h.win);
    expect(h.depth).toBe(2);
    expect(h.win.history.state).toEqual({ verifyGuard: true });
  });
});

describe("listenForBack", () => {
  it("steps the flow back instead of leaving, and keeps guarding while the flow handles Back", () => {
    const h = fakeHistoryWindow();
    // review -> capture (handled) -> document (not handled)
    const screens = ["review", "capture", "document"];
    let at = 0;
    const handled = (name: string) => name !== "document";
    pushBackGuard(h.win);
    const stop = listenForBack(
      {
        handlesBack: () => handled(screens[at]),
        stepBack: () => handled(screens[++at]),
      },
      h.win,
    );
    h.pressBack();
    expect(screens[at]).toBe("capture");
    expect(h.left).toBe(false);
    expect(h.win.history.state).toEqual({ verifyGuard: true });
    h.pressBack();
    expect(screens[at]).toBe("document");
    // On the document list there is no guard: the next Back leaves the page.
    expect(h.index).toBe(0);
    h.pressBack();
    expect(h.left).toBe(true);
    stop();
    expect(h.listeners).toBe(0);
  });

  it("goes on leaving when the flow moved on to a screen that does not handle Back", () => {
    const h = fakeHistoryWindow();
    pushBackGuard(h.win);
    let stepped = false;
    listenForBack({ handlesBack: () => false, stepBack: () => (stepped = true) }, h.win);
    h.pressBack();
    expect(stepped).toBe(false);
    expect(h.left).toBe(true);
  });

  it("keeps the guard when Back does nothing (during the upload)", () => {
    const h = fakeHistoryWindow();
    pushBackGuard(h.win);
    listenForBack({ handlesBack: () => true, stepBack: () => true }, h.win);
    h.pressBack();
    h.pressBack();
    expect(h.left).toBe(false);
    expect(h.win.history.state).toEqual({ verifyGuard: true });
  });
});
