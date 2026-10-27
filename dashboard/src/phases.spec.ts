import { expect, test } from "vitest";
import { sections } from "./phases";
import type { Entry } from "./types";

const step = { kind: "step", step: 8, stage: "b 1/1", name: "RUN make", seconds: null } as const;

test("a log's sections, in order", () => {
  const entries: Entry[] = [
    { kind: "meta", text: "Starting" },
    { kind: "phase", phase: "setup", at: 1 },
    { kind: "raw", text: "Cloning" },
    { kind: "phase", phase: "image", at: 2 },
    { ...step, status: "running", error: null },
    { ...step, status: "error", error: "exit code: 1" },
    { kind: "phase", phase: "work", at: 3 },
    { kind: "tool", name: "Bash", text: "npm test" },
    { kind: "output", text: "1 failed", error: true },
    { kind: "output", text: "ok", error: false },
    { kind: "phase", phase: "push", at: 4 },
    { kind: "phase", phase: "work", at: 5 },
  ];
  const got = sections(entries);
  expect(got.map((s) => [s.phase, s.at, s.entries.length])).toEqual([
    ["setup", 1, 2],
    ["image", 2, 2],
    ["work", 3, 3],
    ["push", 4, 0],
    ["work", 5, 0],
  ]);
  // The run's first line goes with the first section.
  expect(got[0].entries[0]).toEqual({ kind: "meta", text: "Starting" });
});

test("a log from before phases is one work section; an empty one has none", () => {
  const entries: Entry[] = [
    { kind: "meta", text: "Starting" },
    { kind: "output", text: "bad", error: true },
  ];
  expect(sections(entries)).toEqual([{ phase: "work", at: null, entries }]);
  expect(sections([])).toEqual([]);
});
