import { expect, test } from "vitest";
import {
  withoutMarker,
  clock,
  failuresFail,
  fields,
  type Item,
  logSections,
  plainText,
  search,
  shortDuration,
  timeLabel,
  toolLabel,
} from "./logModel";
import type { Entry, Phase } from "./types";

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
  expect(list.map((s) => [s.phase, s.seconds, s.failures, s.failed])).toEqual([
    ["setup", 12, 0, false],
    ["image", 134, 1, true],
    // A command that exited non-zero: counted, but the work didn't fail.
    ["work", 85, 1, false],
    ["push", 9, 0, false],
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
  expect(bash.kind === "tool" && bash.outputs).toEqual([{ text: "✖ retries once", error: true }]);
  const last = work.items.at(-1)!;
  expect(last.kind === "result" && last.text).toBe("Which?");
});

test("withoutMarker: at the start or on a line of its own, never quoted in a sentence", () => {
  expect(withoutMarker("<!-- needs-input -->\nWhich?")).toBe("Which?");
  expect(withoutMarker("## Avis\n\n<!-- needs-input -->\nLequel ?")).toBe("## Avis\n\nLequel ?");
  // Shown in a code block, or after a numbered line: the reply's text, as the listener reads it.
  const shown = "Done.\n```\n<!-- needs-input -->\n```";
  expect(withoutMarker(shown)).toBe(shown);
  expect(withoutMarker("Done.\n1. Fixed\n<!-- needs-input -->")).toBe(
    "Done.\n1. Fixed\n<!-- needs-input -->",
  );
  const quoted = "I start with `<!-- needs-input -->` to ask.";
  expect(withoutMarker(`${quoted}\n<!-- needs-input -->\nWhich?`)).toBe(`${quoted}\nWhich?`);
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

test("a run that ended in error: an error, not a failed command", () => {
  const [work] = logSections(
    [{ kind: "result", status: "error", minutes: 1, text: "API error" }],
    0,
    false,
  );
  expect(work.failures).toBe(0);
  expect(work.failed).toBe(true);
  expect(search([work], "api", "errors").matches).toHaveLength(1);
});

test("a failed command fails the push section, not the work or the wrap-up", () => {
  const failing = (phase: Phase): Entry[] => [
    { kind: "phase", phase, at: 0 },
    { kind: "tool", name: "Bash", text: "git push" },
    { kind: "output", text: "rejected", error: true },
  ];
  const list = logSections(
    [...failing("work"), ...failing("push"), ...failing("wrap-up")],
    0,
    false,
  );
  expect(list.map((s) => [s.phase, s.failures, s.failed, failuresFail(s.phase)])).toEqual([
    ["work", 1, false, false],
    ["push", 1, true, true],
    ["wrap-up", 1, false, false],
  ]);
});

test("search takes the query as typed: no character is special", () => {
  const [work] = logSections([{ kind: "text", text: "a.b a+b (a)" }], 0, false);
  expect(search([work], "a.b", "all").matches).toHaveLength(1);
  expect(search([work], "(A)", "all").matches).toHaveLength(1);
});

test("durations", () => {
  expect([6, 134, 3725].map(shortDuration)).toEqual(["6s", "2m 14s", "1h 2m"]);
});

test("toolLabel: an MCP call's server and tool, Playwright's without browser_", () => {
  expect(toolLabel("mcp__playwright__browser_navigate")).toEqual({
    server: "playwright",
    tool: "navigate",
  });
  expect(toolLabel("mcp__playwright__browser_take_screenshot")?.tool).toBe("take_screenshot");
  expect(toolLabel("mcp__probe__browser_open")).toEqual({ server: "probe", tool: "browser_open" });
  // The server ends at the first `__`: the rest is the tool's.
  expect(toolLabel("mcp__db__run__query")).toEqual({ server: "db", tool: "run__query" });
  for (const name of ["Bash", "Read", "mcp__", "mcp__x", "mcp__x__", "my_mcp__a__b"])
    expect(toolLabel(name)).toBeNull();
});

test("search reads an MCP call's full name, after its outputs; not a Bash call's", () => {
  const [work] = logSections(
    [
      { kind: "tool", name: "mcp__playwright__browser_navigate", text: '{"url":"http://a"}' },
      { kind: "output", text: "ok", error: false },
      { kind: "tool", name: "Bash", text: "ls" },
    ],
    0,
    false,
  );
  expect(fields(work.items[0])).toEqual([
    '{"url":"http://a"}',
    "ok",
    "mcp__playwright__browser_navigate",
  ]);
  expect(fields(work.items[1])).toEqual(["ls"]);
  expect(search([work], "playwright", "all").starts).toEqual(
    new Map([[`${work.items[0].id}:2`, 0]]),
  );
  expect(search([work], "navigate", "all").matches).toHaveLength(1);
  expect(search([work], "bash", "all").matches).toEqual([]);
  expect(plainText([work])).toContain('[mcp__playwright__browser_navigate] {"url":"http://a"}');
});

// #414: outputs go with their call by id, so each call's time is its own.
const work = (entries: Entry[]): Entry[] => [{ kind: "phase", phase: "work", at: 0 }, ...entries];
const tools = (entries: Entry[], end: number, live: boolean) =>
  logSections(work(entries), end, live)[0].items.filter(
    (i): i is Extract<Item, { kind: "tool" }> => i.kind === "tool",
  );

test("parallel calls: each output under its own call, by id; by order without ids", () => {
  const [a, b] = tools(
    [
      { kind: "tool", name: "Bash", text: "npm test", id: "t1", at: 1000 },
      { kind: "tool", name: "Read", text: "a.md", id: "t2", at: 1000 },
      { kind: "output", text: "a", error: false, id: "t2", at: 1200 },
      { kind: "output", text: "ok", error: false, id: "t1", at: 246000 },
    ],
    300000,
    false,
  );
  expect(a.outputs.map((o) => o.text)).toEqual(["ok"]);
  expect(b.outputs.map((o) => o.text)).toEqual(["a"]);
  // Slow: its time; fast: none.
  expect(a.time).toEqual({ seconds: 245, state: "done" });
  expect(b.time).toBeNull();
  expect(timeLabel(a.time!)).toBe("4m 05s");
  // An older log: by order, and no time.
  const [c, d] = tools(
    [
      { kind: "tool", name: "Bash", text: "npm test" },
      { kind: "tool", name: "Read", text: "a.md" },
      { kind: "output", text: "a", error: false },
      { kind: "output", text: "ok", error: false },
    ],
    300000,
    false,
  );
  expect(c.outputs).toEqual([]);
  expect(d.outputs.map((o) => o.text)).toEqual(["a", "ok"]);
  expect([c.time, d.time]).toEqual([null, null]);
});

test("a call's output in the next section still goes with it", () => {
  const sections = logSections(
    [
      ...work([{ kind: "tool", name: "Bash", text: "npm test", id: "t1", at: 0 }]),
      { kind: "phase", phase: "push", at: 1000 },
      { kind: "tool", name: "Bash", text: "git push", id: "t2", at: 1000 },
      { kind: "output", text: "ok", error: false, id: "t1", at: 12000 },
      { kind: "output", text: "pushed", error: false, id: "t2", at: 2000 },
    ],
    20000,
    false,
  );
  const [test, push] = sections.map((s) => s.items[0]);
  expect(test.kind === "tool" && test.outputs.map((o) => o.text)).toEqual(["ok"]);
  expect(test.kind === "tool" && test.time).toEqual({ seconds: 12, state: "done" });
  expect(push.kind === "tool" && push.outputs.map((o) => o.text)).toEqual(["pushed"]);
});

test("the call in progress: a timer after 10 s, live; unfinished once the run ended", () => {
  const entries: Entry[] = [
    { kind: "tool", name: "Bash", text: "npm test", id: "t1", at: 1000 },
    { kind: "tool", name: "Read", text: "a.md", id: "t2", at: 1000 },
    { kind: "output", text: "a", error: false, id: "t2", at: 1100 },
  ];
  expect(tools(entries, 9000, true)[0].time).toBeNull();
  const [running] = tools(entries, 43000, true);
  expect(running.time).toEqual({ seconds: 42, state: "running" });
  expect(timeLabel(running.time!)).toBe("⏱ 0:42");
  // Its output stops the timer.
  const done = [...entries, { kind: "output", text: "ok", error: false, id: "t1", at: 50000 }];
  expect(tools(done as Entry[], 90000, true)[0].time).toEqual({ seconds: 49, state: "done" });
  // The run ended (finished, cancelled, timed out) first: its time up to the end, whatever it.
  const [left] = tools(entries, 4000, false);
  expect(left.time).toEqual({ seconds: 3, state: "unfinished" });
  expect(timeLabel(left.time!)).toBe("3s, unfinished");
  expect(plainText(logSections(work(entries), 4000, false))).toContain(
    "[Bash] npm test · 3s, unfinished",
  );
});

test("a call without an id and no output runs only while it is the log's last line", () => {
  // Antigravity's: whether it has an output to come isn't known.
  const command: Entry = { kind: "tool", name: "command", text: "false", at: 1000 };
  expect(tools([command], 30000, true)[0].time).toEqual({ seconds: 29, state: "running" });
  const later: Entry[] = [command, { kind: "text", text: "Done." }];
  expect(tools(later, 30000, true)[0].time).toBeNull();
});

test("a call that came whole never runs, even as the log's last line", () => {
  // Codex's edits and searches: done as they come.
  const edit: Entry = { kind: "tool", name: "edit", text: "a.md", done: true, at: 1000 };
  expect(tools([edit], 30000, true)[0].time).toBeNull();
  expect(tools([edit], 30000, false)[0].time).toBeNull();
});

test("a running build step: a timer from its first line, while its build runs", () => {
  const build = (live: boolean, end: number, after: Entry[] = []) =>
    logSections(
      [
        { kind: "phase", phase: "image", at: 0 },
        step(1, "running", { at: 1000 }),
        step(1, "done", { seconds: 0.1, at: 1000 }),
        step(2, "running", { at: 2000 }),
        ...after,
      ],
      end,
      live,
    )[0].items.flatMap((i) => (i.kind === "step" ? [i.step.time] : []));
  expect(build(true, 5000)).toEqual([null, null]);
  expect(build(true, 74000)).toEqual([null, { seconds: 72, state: "running" }]);
  expect(build(true, 80000, [step(2, "done", { seconds: 60 })])).toEqual([null, null]);
  // Past its build, a step that never said how it ended isn't timed.
  expect(build(true, 80000, [{ kind: "phase", phase: "setup", at: 70000 }])).toEqual([null, null]);
  // An older log: no times.
  expect(
    logSections(
      [{ kind: "phase", phase: "image", at: 0 }, step(1, "running")],
      60000,
      true,
    )[0].items.flatMap((i) => (i.kind === "step" ? [i.step.time] : [])),
  ).toEqual([null]);
});

test("clock: a running timer", () => {
  expect(clock(9.7)).toBe("0:09");
  expect(clock(725)).toBe("12:05");
  expect(clock(3729)).toBe("1:02:09");
});

// A call's or output's line cut at MAX_LINE: no wrong pairing, no endless timer.
test("an output with an id no call has stands on its own, not under the call before it", () => {
  const items = logSections(
    work([
      { kind: "tool", name: "Bash", text: "ls", id: "t1", at: 1000 },
      { kind: "raw", text: '{"type":"assistant"… (line cut)' },
      { kind: "output", text: "big", error: false, id: "t2", at: 2000 },
    ]),
    60000,
    true,
  )[0].items;
  expect(items.map((i) => i.kind)).toEqual(["tool", "raw", "output"]);
  const [ls] = items;
  expect(ls.kind === "tool" && ls.time).toEqual({ seconds: 59, state: "running" });
});

test("a call whose output never made it to the log ends with the agent's turn", () => {
  const entries: Entry[] = [
    { kind: "tool", name: "Read", text: "shot.png", id: "t1", at: 1000 },
    { kind: "raw", text: '{"type":"user"… (line cut)' },
    { kind: "result", status: "ok", text: "Done.", minutes: 1 },
  ];
  expect(tools(entries, 90000, true)[0].time).toBeNull();
  expect(tools(entries, 90000, false)[0].time).toBeNull();
});

test("as text: a running build step with its timer", () => {
  const text = plainText(
    logSections(
      [{ kind: "phase", phase: "image", at: 0 }, step(4, "running", { at: 1000 })],
      43000,
      true,
    ),
  );
  expect(text).toContain("#4 [build 4/9] RUN step 4 · ⏱ 0:42");
});
