import { expect, test } from "vitest";
import { logSections, plainText, search, shortDuration } from "./logModel";
import type { Entry } from "./types";

const step = (n: number, status: string, extra: object = {}) =>
  ({
    kind: "step",
    step: n,
    stage: `build ${n}/9`,
    name: `RUN step ${n}`,
    status,
    seconds: null,
    error: null,
    ...extra,
  }) as Entry;

const run: Entry[] = [
  { kind: "meta", text: "Starting" },
  { kind: "phase", phase: "setup", at: 0 },
  { kind: "raw", text: "Cloning" },
  { kind: "phase", phase: "image", at: 6000 },
  step(1, "running"),
  step(1, "cached"),
  step(2, "running"),
  step(2, "cached"),
  step(3, "running"),
  { kind: "raw", step: 3, text: "added 412 packages" },
  step(3, "done", { seconds: 41 }),
  step(4, "running"),
  { kind: "raw", step: 4, text: "npm ERR! retry failed" },
  step(4, "error", { error: "exit code: 1" }),
  { kind: "phase", phase: "setup", at: 140000 },
  { kind: "raw", text: "Sandbox started" },
  { kind: "phase", phase: "work", at: 146000 },
  { kind: "text", text: "I'll add a retry." },
  { kind: "tool", name: "Bash", text: "node --test" },
  { kind: "output", text: "✖ retries once", error: true },
  { kind: "tool", name: "Read", text: "listener/deliveries.mjs" },
  { kind: "phase", phase: "push", at: 200000 },
  { kind: "tool", name: "Bash", text: "git push" },
  { kind: "phase", phase: "work", at: 209000 },
  { kind: "result", status: "ok", minutes: 4, text: "Retries now back off." },
];

test("one section per phase, in the order first entered, their times added up", () => {
  const list = logSections(run, 240000, false);
  expect(list.map((s) => [s.phase, s.seconds, s.failures])).toEqual([
    ["setup", 12, 0],
    ["image", 134, 1],
    ["work", 85, 1],
    ["push", 9, 0],
  ]);
  // Setup's both parts, the run's first line first.
  expect(list[0].items.map((i) => ("text" in i ? i.text : i.kind))).toEqual([
    "Starting",
    "Cloning",
    "Sandbox started",
  ]);
});

test("an image build: its cached steps as one line, each other step with its output", () => {
  const [, image] = logSections(run, 240000, false);
  expect(image.items.map((i) => i.kind)).toEqual(["cached", "step", "step"]);
  const [cached, done, failed] = image.items;
  expect(cached.kind === "cached" && cached.steps.map((s) => s.step)).toEqual([1, 2]);
  expect(done.kind === "step" && [done.step.status, done.step.seconds, done.step.output]).toEqual([
    "done",
    41,
    ["added 412 packages"],
  ]);
  expect(failed.kind === "step" && failed.step.error).toBe("exit code: 1");
});

test("work: messages, tool calls with their output, the result without its marker", () => {
  const work = logSections(
    [
      ...run,
      { kind: "result", status: "needs-input", minutes: 1, text: "<!-- needs-input -->\nWhich?" },
    ],
    240000,
    false,
  )[2];
  expect(work.items.map((i) => i.kind)).toEqual(["say", "tool", "tool", "result", "result"]);
  const bash = work.items[1];
  expect(bash.kind === "tool" && bash.outputs).toEqual([
    { kind: "output", text: "✖ retries once", error: true },
  ]);
  const last = work.items.at(-1)!;
  expect(last.kind === "result" && last.text).toBe("Which?");
});

test("a log from before phases is one work section; a live run's current section is its last", () => {
  const old = logSections([{ kind: "text", text: "Hi" }], 0, false);
  expect(old.map((s) => [s.phase, s.seconds, s.current])).toEqual([["work", null, false]]);
  const live = logSections(run.slice(0, 20), 150000, true);
  expect(live.map((s) => s.current)).toEqual([false, false, true]);
});

test("search: every match in order, any case, by section and item, with the filter", () => {
  const list = logSections(run, 240000, false);
  const all = search(list, "RETR", "all");
  // The failed step's output, the message, the tool's output, the result.
  expect(all.matches.map((m) => m.section)).toEqual(["image", "work", "work", "work"]);
  expect(all.hits.get("image")).toBe(1);
  expect(all.hits.get("work")).toBe(3);
  expect(all.starts.get("work:1:1")).toBe(2);
  expect(search(list, "retr", "messages").matches).toHaveLength(2);
  expect(search(list, "retr", "errors").matches).toHaveLength(2);
  expect(search(list, "", "all").matches).toEqual([]);
});

test("as text: each section under its title", () => {
  const text = plainText(logSections(run, 240000, false));
  expect(text).toContain("== Image build ==\n#1–#2 RUN step 1 … RUN step 2 · CACHED\n");
  expect(text).toContain(
    "#4 [build 4/9] RUN step 4 · ERROR: exit code: 1\n    npm ERR! retry failed",
  );
  expect(text).toContain("[Bash] node --test\n    ERROR: ✖ retries once");
  expect(text).toContain("== Push and pull request ==\n[Bash] git push");
});

test("durations", () => {
  expect([6, 134, 3725].map(shortDuration)).toEqual(["6s", "2m 14s", "1h 2m"]);
});
