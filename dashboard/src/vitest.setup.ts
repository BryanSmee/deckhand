// What every spec starts from: the page at its root, nothing stored, a wide screen and a log
// stream that never speaks (jsdom has neither), and nothing seen: api.ts keeps the backlogs
// for the page's life. A spec stubs more, or other ones, in its own beforeEach.
import { cleanup } from "@testing-library/preact";
import { afterEach, beforeEach, vi } from "vitest";
import { forgetBacklogs } from "./api";

beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
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
  forgetBacklogs();
});
