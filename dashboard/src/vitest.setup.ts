// What every spec starts from: the page at its root, nothing stored, a browser in American
// English (the specs read English texts and dates, whatever the machine's language), a wide
// screen and a log stream that never speaks (jsdom has neither), and nothing seen: api.ts keeps the backlogs
// for the page's life. A spec stubs more, or other ones, in its own beforeEach.
import { cleanup } from "@testing-library/preact";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { forgetBacklogs } from "./api";

beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
});

afterEach(() => {
  // Unmounted, not only taken off the page: the next test's hash changes would reach it.
  cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetBacklogs();
});

// Preact runs effects after the next frame or 35 ms (its hooks' afterNextFrame()), whichever
// comes first: a file's last render mustn't leave that timer to fire once jsdom is gone, where it
// calls a cancelAnimationFrame that no longer exists (#563). Armed after it and for longer, this
// one fires after it, however late the timers run.
afterAll(() => new Promise((resolve) => setTimeout(resolve, 50)));
