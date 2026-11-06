// The run log: its sections folded as they should be, search through folded ones, filters,
// folding it all, copying it, a phone's bars, and following a live run.
import { act, fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { useRunLog } from "./api";
import { Log } from "./Log";
import { stampLabel } from "./logModel";
import { getPref, setPref } from "./prefs";
import { FakeSource } from "./testUtils";
import type { Entry, Run } from "./types";

const run: Run = {
  id: "acme-app-19-1",
  key: "acme/app#19",
  kind: "issue",
  title: "Retries",
  repo: "acme/app",
  replyTo: 19,
  mode: "start",
  taskMode: "work",
  startedAt: 0,
  finishedAt: 240000,
  status: "ok",
};

const step = { kind: "step", stage: "build 1/3" } as const;
const entries: Entry[] = [
  { kind: "phase", phase: "setup", at: 0 },
  { kind: "meta", text: "Cloned acme/app" },
  { kind: "phase", phase: "image", at: 6000 },
  { ...step, step: 1, name: "FROM node", status: "cached", seconds: null, error: null },
  { ...step, step: 2, name: "COPY . .", status: "cached", seconds: null, error: null },
  { ...step, step: 3, name: "RUN npm ci", status: "running", seconds: null, error: null },
  { kind: "raw", step: 3, text: "npm warn retry later" },
  { ...step, step: 3, name: "RUN npm ci", status: "done", seconds: 41, error: null },
  { kind: "phase", phase: "work", at: 60000 },
  { kind: "text", text: "I'll add a retry with backoff." },
  { kind: "tool", name: "Bash", text: "node --test" },
  { kind: "output", text: "✖ retries once\nAssertionError", error: true },
  { kind: "tool", name: "Bash", text: "node --test" },
  { kind: "output", text: "58 passed", error: false },
  { kind: "phase", phase: "push", at: 230000 },
  { kind: "tool", name: "Bash", text: "git push origin issue-19-retry" },
  { kind: "output", text: "pushed", error: false },
];

beforeEach(() => {
  FakeSource.last = null;
  vi.stubGlobal("EventSource", FakeSource);
});

type Props = Omit<Parameters<typeof Log>[0], "entries">;

// The log as the page shows it, streamed.
function Streamed(props: Props) {
  const { entries } = useRunLog(props.run.id);
  return <Log {...props} entries={entries} />;
}

const show = (props: Partial<Props> = {}, log = entries) => {
  const view = render(<Streamed run={run} now={240000} {...props} />);
  act(() => FakeSource.last!.emit("entries", log));
  return view;
};

const section = (title: string) =>
  within(screen.getByRole("log")).getByText(title, { selector: "summary *" }).closest("details")!;
const opened = () =>
  ["Setup", "Image build", "Work", "Push and pull request"].filter((t) => section(t).open);
// Its dot is red: the section failed.
const redDot = (title: string) => !!section(title).querySelector("summary > .s-err");
const box = () => screen.getByRole("searchbox", { name: "Search this log" });

test("work open, the rest folded; cached steps on one line, each other step folded", () => {
  show();
  expect(opened()).toEqual(["Work"]);
  const image = section("Image build");
  expect(image.querySelector("summary")!.textContent).toMatch(/3 steps · 2 cached.*54s/);
  expect(within(image).getByText("#1–#2 FROM node … COPY . . · CACHED")).toBeTruthy();
  expect(within(image).getByText("RUN npm ci").closest("details")!.open).toBe(false);
  // The failed command open, the one that passed folded; counted, but the work didn't fail: no
  // red dot, no red badge.
  const work = section("Work");
  expect(work.querySelector("summary")!.textContent).toMatch(
    /1 message · 2 tool calls.*1 failed command/,
  );
  expect(redDot("Work")).toBe(false);
  expect(work.querySelector("summary .s-err")).toBeNull();
  const calls = within(work)
    .getAllByText("node --test")
    .map((n) => n.closest("details")!.open);
  expect(calls).toEqual([true, false]);
});

// #923: the run page's log, its stream reconnecting: what it sends again isn't shown twice.
test("a stream that reconnects shows each line once", () => {
  render(<Streamed run={run} now={240000} />);
  const source = FakeSource.last!;
  const line = { kind: "meta", text: "Cloned acme/app" } satisfies Entry;
  act(() => {
    source.open();
    source.emit("entries", [{ kind: "phase", phase: "setup", at: 0 }, line], 100);
  });
  act(() => {
    source.open();
    source.emit("entries", [{ kind: "phase", phase: "setup", at: 0 }, line], 100);
    source.emit("entries", [{ kind: "meta", text: "Installed" }], 140);
  });
  expect(screen.getAllByText("Cloned acme/app").length).toBe(1);
  expect(screen.getByText("Installed")).toBeTruthy();
});

test("a red dot for a section that failed: a failed build step, a run that ended in error, a push", () => {
  show({}, [
    ...entries.slice(0, 7),
    { ...step, step: 3, name: "RUN npm ci", status: "error", seconds: null, error: "exit code: 1" },
    ...entries.slice(8, 14),
    { kind: "result", status: "error", minutes: 4, text: "API error" },
    { kind: "phase", phase: "push", at: 230000 },
    { kind: "tool", name: "Bash", text: "git push origin issue-19-retry" },
    { kind: "output", text: "rejected", error: true },
  ]);
  expect(["Setup", "Image build", "Work", "Push and pull request"].map(redDot)).toEqual([
    false,
    true,
    true,
    true,
  ]);
  // The build's failed step and the push's failed command keep their red badge; the work's
  // failed command is plain text, and its badge says the agent ended in error: the dot isn't
  // alone.
  const badge = (title: string) => section(title).querySelector("summary .s-err:not(summary > *)");
  expect(badge("Image build")!.textContent).toBe("1 failed step");
  expect(badge("Push and pull request")!.textContent).toBe("1 failed command");
  expect(badge("Work")!.textContent).toBe("Ended in error");
  expect(section("Work").querySelector("summary")!.textContent).toMatch(
    /1 failed command.*Ended in error/,
  );
});

test("search finds text in folded sections, opens them, and steps through the matches", () => {
  show();
  fireEvent.input(box(), { target: { value: "RETR" } });
  expect(screen.getByText("1 / 4")).toBeTruthy();
  // The first match is in the folded image build: it opens, with its step.
  expect(opened()).toContain("Image build");
  const current = () => document.querySelector("mark[data-current]")!;
  expect(current().closest("details")!.textContent).toContain("RUN npm ci");
  expect(current().closest("details")!.open).toBe(true);
  expect(section("Setup").querySelector("summary")!.textContent).toContain("no match");
  expect(section("Work").querySelector("summary")!.textContent).toContain("2 matches");
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(screen.getByText("2 / 4")).toBeTruthy();
  expect(current().closest("p")!.textContent).toBe("I'll add a retry with backoff.");
  fireEvent.keyDown(box(), { key: "Enter" });
  fireEvent.keyDown(box(), { key: "Enter" });
  // The last one, in the folded push section: open now.
  expect(screen.getByText("4 / 4")).toBeTruthy();
  expect(section("Push and pull request").open).toBe(true);
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(screen.getByText("1 / 4")).toBeTruthy();
  fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
  expect(screen.getByText("4 / 4")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
  expect(screen.getByText("3 / 4")).toBeTruthy();
  expect(current().textContent).toBe("retr");
  expect(current().closest("details")!.open).toBe(true);
});

test("filters: errors only, with their count", () => {
  show();
  const errors = screen.getByRole("button", { name: "Errors 1" });
  fireEvent.click(errors);
  const log = screen.getByRole("log");
  expect(within(log).queryByText("Setup")).toBeNull();
  expect(within(log).getAllByText("node --test")).toHaveLength(1);
  expect(within(log).queryByText(/I'll add a retry/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Messages" }));
  expect(within(log).getByText("I'll add a retry with backoff.")).toBeTruthy();
  expect(within(log).queryByText("node --test")).toBeNull();
});

test("expand all and collapse all", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  expect(opened()).toHaveLength(4);
  expect(
    [...screen.getByRole("log").querySelectorAll<HTMLDetailsElement>("details details")].every(
      (d) => d.open,
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(opened()).toEqual([]);
});

test("a fold the reader opens stays open through filters; a new search starts over", () => {
  show();
  const setup = section("Setup");
  setup.open = true;
  fireEvent(setup, new Event("toggle"));
  fireEvent.input(box(), { target: { value: "x" } });
  fireEvent.input(box(), { target: { value: "" } });
  expect(section("Setup").open).toBe(false);
  section("Setup").open = true;
  fireEvent(section("Setup"), new Event("toggle"));
  fireEvent.click(screen.getByRole("button", { name: "Errors 1" }));
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(section("Setup").open).toBe(true);
});

test("a fold the reader closed opens again when the next match is in it", () => {
  show();
  fireEvent.input(box(), { target: { value: "node --test" } });
  expect(screen.getByText("1 / 2")).toBeTruthy();
  const work = section("Work");
  work.open = false;
  fireEvent(work, new Event("toggle"));
  expect(section("Work").open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  expect(section("Work").open).toBe(true);
  const current = document.querySelector("mark[data-current]")!;
  expect(current.closest("details")!.open).toBe(true);
});

test("marks stay on their text when lowercasing changes its length", () => {
  show({}, [{ kind: "text", text: "İİ retry" }]);
  fireEvent.input(box(), { target: { value: "RETRY" } });
  expect(document.querySelector("mark")!.textContent).toBe("retry");
});

test("an old log, without phases, is one work section", () => {
  show({}, [
    { kind: "meta", text: "Starting" },
    { kind: "tool", name: "Read", text: "a.mjs" },
  ]);
  const log = screen.getByRole("log");
  expect([...log.querySelectorAll(":scope > details")]).toHaveLength(1);
  expect(section("Work").open).toBe(true);
  expect(within(section("Work")).getByText("a.mjs")).toBeTruthy();
});

test("copy: the log as text", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  show();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy the log" }));
  });
  expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  expect(writeText.mock.calls[0][0]).toMatch(/^== Setup ==\n› Cloned acme\/app\n/);
});

// #719: each item's time of day on its left, its section's start on its header.
const stamped: Entry[] = [
  { kind: "meta", text: "Starting", at: 1000 },
  { kind: "phase", phase: "setup", at: 2000 },
  { kind: "raw", text: "npm ci", at: 3000 },
  { kind: "phase", phase: "work", at: 60000 },
  // One with no time (a log from before them): an empty cell.
  { kind: "meta", text: "Claude Code started" },
  { kind: "text", text: "Looking.", at: 61000 },
  { kind: "tool", name: "Bash", text: "ls", id: "t1", at: 62000 },
  { kind: "output", text: "a.md", error: false, id: "t1", at: 63000 },
  { kind: "result", status: "ok", text: "Done.", minutes: 1, at: 125000 },
];

test("timestamps: off at first; the toolbar's clock shows them, kept, at once in every view", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  show({}, stamped);
  const log = screen.getByRole("log");
  expect(log.querySelector("time")).toBeNull();
  const clock = screen.getByRole("button", { name: "Show timestamps" });
  expect(clock.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(clock);
  expect(clock.getAttribute("aria-pressed")).toBe("true");
  expect(getPref("logTimes")).toBe(true);
  expect(localStorage.getItem("deckhand.log.times")).toBe("1");
  // Every item's, and each section's start, on its header.
  const times = [...log.querySelectorAll("time")].map((t) => t.textContent);
  expect(times).toEqual([2000, 1000, 3000, 60000, 61000, 62000, 125000].map(stampLabel));
  expect(stampLabel(62000)).toMatch(/^\d\d:\d\d:\d\d$/);
  expect(section("Work").querySelector("summary time")!.textContent).toBe(stampLabel(60000));
  // The full date, and the time since the run's start, on hover.
  const call = within(section("Work")).getByText("ls").closest("details")!.parentElement!;
  expect(call.querySelector("time")!.getAttribute("title")).toMatch(
    /· 1m 02s after the run started$/,
  );
  // No time: an empty cell, the column kept.
  const untimed = within(section("Work")).getByText("Claude Code started").closest("div")!;
  const cell = untimed.parentElement!.firstElementChild!;
  expect(cell.tagName).toBe("SPAN");
  expect(cell.textContent).toBe("");
  // Copied with them.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy the log" }));
  });
  expect(writeText.mock.calls[0][0]).toContain(`${stampLabel(2000)} == Setup ==\n`);
  // Preferences, or another tab, turns them off: the log as it was.
  act(() => setPref("logTimes", false));
  expect(log.querySelector("time")).toBeNull();
  expect(log.querySelector("[class*=stamped]")).toBeNull();
});

test("copy without a clipboard, and the fallback fails: it says so", async () => {
  vi.stubGlobal("navigator", {});
  document.execCommand = () => false;
  show();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy the log" }));
  });
  expect(
    await screen.findByRole("button", { name: "Couldn't copy: download it instead" }),
  ).toBeTruthy();
});

test("a phone: an action bar, then a search that takes the header, with its chips", () => {
  const onSearching = vi.fn();
  const { rerender } = show({ touch: true, onSearching });
  expect(screen.queryByRole("searchbox")).toBeNull();
  const bar = screen.getByRole("navigation", { name: "Log" });
  fireEvent.click(within(bar).getByRole("button", { name: "Fold all" }));
  expect(opened()).toEqual([]);
  // Next error opens the failed command's section.
  fireEvent.click(within(bar).getByRole("button", { name: "Next error" }));
  expect(opened()).toEqual(["Work"]);
  fireEvent.click(within(bar).getByRole("button", { name: "Search" }));
  expect(onSearching).toHaveBeenCalledWith(true);

  rerender(<Streamed run={run} now={240000} touch searching onSearching={onSearching} />);
  fireEvent.input(box(), { target: { value: "retr" } });
  const matches = screen.getByRole("navigation", { name: "Matches" });
  expect(within(matches).getByRole("status").textContent).toBe("1 of 4 · in Image build");
  fireEvent.click(within(matches).getByRole("button", { name: "Next match" }));
  expect(within(matches).getByRole("status").textContent).toBe("2 of 4 · in Work");
  fireEvent.click(screen.getByRole("button", { name: "Errors 1" }));
  expect(within(matches).getByRole("status").textContent).toBe("1 of 1 · in Work");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onSearching).toHaveBeenLastCalledWith(false);

  // Escape ends it like Done: no query, no filter left behind.
  fireEvent.input(box(), { target: { value: "retr" } });
  fireEvent.click(screen.getByRole("button", { name: "Errors 1" }));
  fireEvent.keyDown(box(), { key: "Escape" });
  rerender(<Streamed run={run} now={240000} touch onSearching={onSearching} />);
  expect(document.querySelector("mark")).toBeNull();
  expect(within(screen.getByRole("log")).getByText("Setup")).toBeTruthy();
});

test("a live run follows its end until the reader scrolls up; Latest brings it back", () => {
  const page = document.createElement("div");
  page.style.overflowY = "auto";
  document.body.append(page);
  let top = 0;
  Object.defineProperties(page, {
    scrollHeight: { get: () => 1000 },
    clientHeight: { get: () => 200 },
    scrollTop: { get: () => top, set: (v: number) => (top = v) },
  });
  render(<Streamed run={{ ...run, status: "running", finishedAt: null }} now={240000} />, {
    container: page,
  });
  act(() => FakeSource.last!.emit("entries", entries));
  expect(top).toBe(1000);
  expect(screen.getByText("Working… following the log live")).toBeTruthy();
  top = 300;
  fireEvent.scroll(page);
  expect(screen.queryByText("Working… following the log live")).toBeNull();
  // New lines don't move the reader.
  act(() => FakeSource.last!.emit("entries", [{ kind: "text", text: "More" }]));
  expect(top).toBe(300);
  fireEvent.click(screen.getByRole("button", { name: "Latest" }));
  expect(top).toBe(1000);
  expect(screen.getByText("Working… following the log live")).toBeTruthy();
});

test("Preferences: sections with errors folded, long lines unwrapped, changed at once", () => {
  localStorage.setItem("deckhand.log.errors", "0");
  show();
  // Only the work, which isn't open for its error; its failed command folded too.
  expect(opened()).toEqual(["Work"]);
  const calls = () =>
    within(section("Work"))
      .getAllByText("node --test")
      .map((n) => n.closest("details")!.open);
  expect(calls()).toEqual([false, false]);
  act(() => setPref("logErrors", true));
  expect(calls()).toEqual([true, false]);
  // Long lines scroll sideways unless wrapped.
  const log = screen.getByRole("log").parentElement!;
  expect(log.className).toMatch(/nowrap/);
  act(() => setPref("logWrap", true));
  expect(log.className).not.toMatch(/nowrap/);
});

test("Preferences: a live run's log not followed from the start", () => {
  setPref("logFollow", false);
  const page = document.createElement("div");
  page.style.overflowY = "auto";
  document.body.append(page);
  let top = 0;
  Object.defineProperties(page, {
    scrollHeight: { get: () => 1000 },
    clientHeight: { get: () => 200 },
    scrollTop: { get: () => top, set: (v: number) => (top = v) },
  });
  render(<Streamed run={{ ...run, status: "running", finishedAt: null }} now={240000} />, {
    container: page,
  });
  act(() => FakeSource.last!.emit("entries", entries));
  expect(top).toBe(0);
  expect(screen.getByText("Working…")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Latest" }));
  expect(top).toBe(1000);
});

test("an MCP call: its server as an icon named by the full name, its short tool name first", () => {
  show({}, [
    { kind: "phase", phase: "work", at: 0 },
    { kind: "tool", name: "mcp__playwright__browser_navigate", text: '{"url":"http://a"}' },
    { kind: "tool", name: "mcp__db__query", text: "{}" },
    { kind: "output", text: "3 rows", error: false },
    { kind: "tool", name: "Bash", text: "ls" },
  ]);
  const icon = screen.getByLabelText("mcp__playwright__browser_navigate");
  expect(icon.getAttribute("title")).toBe("mcp__playwright__browser_navigate");
  expect(icon.textContent).toBe("");
  expect(icon.querySelector("svg")).toBeTruthy();
  expect(icon.nextElementSibling!.textContent).toBe('navigate{"url":"http://a"}');
  expect(within(icon.nextElementSibling as HTMLElement).getByText("navigate")).toBeTruthy();
  // Another server, folded with its output: a plug, a different icon, and its tool as it is.
  const other = screen.getByTitle("mcp__db__query");
  expect(other.closest("summary")!.textContent).toContain("query{}");
  expect(other.innerHTML).not.toBe(icon.innerHTML);
  // The agent's own tools as before: their name as text.
  expect(screen.getByText("Bash").getAttribute("role")).toBeNull();
  // Searching the full name marks the icon, as the current match.
  fireEvent.input(box(), { target: { value: "playwright" } });
  expect(screen.getByText("1 / 1")).toBeTruthy();
  expect(icon.querySelector("mark[data-current]")).toBeTruthy();
});

// #414: how long slow calls took, the one in progress timed, one left running marked.
const timed: Entry[] = [
  { kind: "phase", phase: "work", at: 0 },
  { kind: "tool", name: "Bash", text: "npm test", id: "t1", at: 1000 },
  { kind: "tool", name: "Read", text: "a.md", id: "t2", at: 1000 },
  { kind: "output", text: "a", error: false, id: "t2", at: 1100 },
  { kind: "output", text: "58 passed", error: false, id: "t1", at: 246000 },
  { kind: "tool", name: "Bash", text: "npm run build", id: "t3", at: 250000 },
];

test("a slow call shows how long it took, a fast one doesn't; the one in progress ticks", () => {
  const live = { ...run, status: "running", finishedAt: null } as Run;
  const view = show({ run: live, now: 255000 }, timed);
  const summary = (text: string) => screen.getByText(text).closest("summary, div")!;
  expect(summary("npm test").textContent).toMatch(/1 line4m 05s$/);
  expect(summary("a.md").textContent).not.toMatch(/\ds/);
  // Under 10 s, nothing yet; then a timer, ticking with `now`.
  expect(screen.queryByTitle("Running for")).toBeNull();
  view.rerender(<Streamed run={live} now={292000} />);
  const timer = screen.getByTitle("Running for");
  expect(timer.textContent).toBe("⏱ 0:42");
  view.rerender(<Streamed run={live} now={293000} />);
  expect(timer.textContent).toBe("⏱ 0:43");
  // Its output stops it.
  act(() =>
    FakeSource.last!.emit("entries", [
      { kind: "output", text: "built", error: false, id: "t3", at: 294000 },
    ]),
  );
  expect(screen.queryByTitle("Running for")).toBeNull();
  expect(summary("npm run build").textContent).toMatch(/44s$/);
});

test("a call left without output when the run ended: unfinished, timed to the end", () => {
  show({ run: { ...run, status: "cancelled", finishedAt: 253000 } }, timed);
  expect(screen.getByTitle("Still running when the run ended").textContent).toBe("3s, unfinished");
});

test("an older log, without times, shows none", () => {
  show();
  expect(document.querySelector("[title='How long it took']")).toBeNull();
  expect(screen.queryByTitle("Running for")).toBeNull();
});
