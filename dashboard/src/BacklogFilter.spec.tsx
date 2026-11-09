// The Backlog tab's filters: its labels, "Hide sub-issues", "Group by milestone" and the text
// field together, kept in this browser (labels and collapsed sections per repository, the
// toggles for every one).
import { act, fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import {
  labelCounts,
  milestoneSections,
  narrowBacklog,
  NO_LABEL,
  NO_MILESTONE,
} from "./BacklogFilter";
import { BACKLOG as EMPTY, makeState, mockApi } from "./testUtils";
import type { Backlog, BacklogIssue } from "./types";

const state = makeState();

const issue = (number: number, title: string, more: Partial<BacklogIssue> = {}) => ({
  number,
  title,
  url: `https://github.example.com/acme/app/issues/${number}`,
  ...more,
});
const BUG = { name: "bug", color: "d73a4a" };
const IDEA = { name: "idea", color: "a2eeef" };

const BACKLOG: Backlog = {
  ...EMPTY,
  issues: [
    issue(40, "Board filters", { labels: [IDEA], subIssues: 2 }),
    issue(41, "Labels in the backlog", { labels: [IDEA], parent: 40 }),
    issue(42, "Hide sub-issues", { labels: [BUG], parent: 40 }),
    issue(43, "Crash on reload", { labels: [BUG, IDEA] }),
    issue(44, "Docs for the board", { labels: [] }),
    // Its parent isn't listed (closed, or live on the board): never hidden.
    issue(45, "Orphan", { parent: 12 }),
  ],
};

let backlog: Backlog;
let phone = false;
beforeEach(() => {
  backlog = BACKLOG;
  phone = false;
  mockApi({ "api/repos/acme/app/issues": () => backlog });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? !phone : false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

const open = async () => {
  history.replaceState(null, "", "#/acme/app/board");
  const view = render(<Dashboard state={state} error={null} />);
  const area = screen.getByRole("region", { name: "Work queue" });
  await within(area).findByRole("list", { name: "Open issues with no task" });
  return { area, view };
};
const numbers = (area: HTMLElement) =>
  Array.from(
    within(area)
      .getByRole("list", { name: "Open issues with no task" })
      .querySelectorAll("[data-card]"),
    (li) => Number(li.getAttribute("data-number")),
  );
const backlogTab = () => screen.getByRole("tab", { name: /^Backlog/ });
const labelsButton = (area: HTMLElement) =>
  within(area).getByRole("button", { name: "Filter the backlog by label" });
const tick = (area: HTMLElement, name: RegExp) =>
  fireEvent.click(within(area).getByRole("checkbox", { name }));

test("labelCounts: each label with its count by name, No label last", () => {
  expect(labelCounts(BACKLOG.issues)).toEqual([
    { ...BUG, count: 2 },
    { ...IDEA, count: 3 },
    { name: NO_LABEL, color: null, count: 2 },
  ]);
});

test("narrowBacklog: any label ticked, No label, the toggle, and a label gone left out", () => {
  const n = (ticked: string[], hide = false) =>
    narrowBacklog(BACKLOG.issues, ticked, hide).map((i) => i.number);
  expect(n([])).toEqual([40, 41, 42, 43, 44, 45]);
  expect(n(["bug"])).toEqual([42, 43]);
  expect(n(["bug", NO_LABEL])).toEqual([42, 43, 44, 45]);
  // #42's parent, #40, isn't a bug: #42 shows, as nothing else lays it out.
  expect(n(["bug"], true)).toEqual([42, 43]);
  expect(n(["idea"], true)).toEqual([40, 43]);
  expect(n([], true)).toEqual([40, 43, 44, 45]);
  // A label no issue has any more: as if not ticked, rather than an empty list.
  expect(n(["wontfix"])).toEqual([40, 41, 42, 43, 44, 45]);
});

test("labels: listed with their counts; ticked, the list, the count and the placeholder follow", async () => {
  const { area } = await open();
  expect(backlogTab().textContent).toMatch(/6$/);
  fireEvent.click(labelsButton(area));
  const group = within(area).getByRole("group", { name: "Labels to show" });
  expect(
    within(group)
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")!.textContent),
  ).toEqual(["bug2", "idea3", "No label2"]);
  tick(area, /^bug/);
  expect(numbers(area)).toEqual([42, 43]);
  expect(backlogTab().textContent).toMatch(/2$/);
  expect(
    within(area).getByRole("textbox", { name: "Filter the backlog" }).getAttribute("placeholder"),
  ).toBe("Filter 2 open issues");
  // Any of them.
  tick(area, /^No label/);
  expect(numbers(area)).toEqual([42, 43, 44, 45]);
  // Kept for this repo.
  expect(JSON.parse(localStorage.getItem("deckhand.backlog.labels.acme/app")!)).toEqual([
    "bug",
    NO_LABEL,
  ]);
  fireEvent.click(within(area).getByRole("button", { name: "Clear" }));
  expect(numbers(area)).toHaveLength(6);
  expect(localStorage.getItem("deckhand.backlog.labels.acme/app")).toBeNull();
  // Escape closes the list, focus back on its button.
  fireEvent.keyDown(within(area).getByRole("checkbox", { name: /^bug/ }), { key: "Escape" });
  expect(within(area).queryByRole("group", { name: "Labels to show" })).toBeNull();
  expect(document.activeElement).toBe(labelsButton(area));
});

test("Hide sub-issues: those of a listed parent go, the parent keeps its count; kept for every repo", async () => {
  const { area } = await open();
  const toggle = within(area).getByRole("button", { name: "Hide sub-issues" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle);
  expect(numbers(area)).toEqual([40, 43, 44, 45]);
  expect(backlogTab().textContent).toMatch(/4$/);
  const parent = within(area).getByText("Board filters").closest("li")!;
  expect(within(parent).getByText("2 sub-issues · start lays them out")).toBeTruthy();
  expect(localStorage.getItem("deckhand.backlog.hideSubIssues")).toBe("1");
});

test("the text, the labels and the toggle combine; nothing left says no issue matches", async () => {
  const { area } = await open();
  fireEvent.click(within(area).getByRole("button", { name: "Hide sub-issues" }));
  fireEvent.click(labelsButton(area));
  tick(area, /^idea/);
  expect(numbers(area)).toEqual([40, 43]);
  const text = within(area).getByRole("textbox", { name: "Filter the backlog" });
  fireEvent.input(text, { target: { value: "crash" } });
  expect(numbers(area)).toEqual([43]);
  fireEvent.input(text, { target: { value: "labels in" } });
  expect(numbers(area)).toEqual([]);
  expect(within(area).getByText("No open issue matches.")).toBeTruthy();
});

test("kept across a reload: the labels per repo, a label gone dropped from the list", async () => {
  localStorage.setItem("deckhand.backlog.labels.acme/app", JSON.stringify(["bug", "wontfix"]));
  localStorage.setItem("deckhand.backlog.hideSubIssues", "1");
  const { area } = await open();
  // #42's parent isn't a bug: it shows.
  expect(numbers(area)).toEqual([42, 43]);
  // One ticked: the label that's gone isn't counted.
  expect(labelsButton(area).textContent).toBe("Labels1");
  fireEvent.click(labelsButton(area));
  expect(within(area).queryByRole("checkbox", { name: /wontfix/ })).toBeNull();
  // Ticking another keeps it, for when it comes back.
  tick(area, /^idea/);
  expect(JSON.parse(localStorage.getItem("deckhand.backlog.labels.acme/app")!)).toEqual([
    "bug",
    "wontfix",
    "idea",
  ]);
  // Another repo's are its own.
  expect(localStorage.getItem("deckhand.backlog.labels.acme/other")).toBeNull();
});

test("labels show on a wide screen's cards", async () => {
  const { area } = await open();
  const card = within(area).getByText("Crash on reload").closest("li")!;
  expect(within(card).getByText("bug")).toBeTruthy();
  expect(within(card).getByText("idea")).toBeTruthy();
});

test("no label and no sub-issue: neither control, the text field alone", async () => {
  backlog = { ...BACKLOG, issues: [issue(40, "Board filters"), issue(41, "Other")] };
  const { area } = await open();
  expect(within(area).getByRole("textbox", { name: "Filter the backlog" })).toBeTruthy();
  expect(within(area).queryByRole("button", { name: "Filter the backlog by label" })).toBeNull();
  expect(within(area).queryByRole("button", { name: "Hide sub-issues" })).toBeNull();
});

test("a phone: the text field, the labels and the toggle in the sheet", async () => {
  phone = true;
  const { area } = await open();
  expect(within(area).getByRole("textbox", { name: "Filter the backlog" })).toBeTruthy();
  fireEvent.click(labelsButton(area));
  tick(area, /^bug/);
  expect(numbers(area)).toEqual([42, 43]);
  fireEvent.click(within(area).getByRole("button", { name: "Hide sub-issues" }));
  // #42's parent isn't a bug: it stays.
  expect(numbers(area)).toEqual([42, 43]);
  tick(area, /^bug/);
  tick(area, /^idea/);
  expect(numbers(area)).toEqual([40, 43]);
});

const V1 = { number: 1, title: "v1", dueOn: Date.UTC(2026, 11, 1) };
const V2 = { number: 2, title: "v2", dueOn: Date.UTC(2027, 0, 15) };
const LATER = { number: 3, title: "Later", dueOn: null };
const ALPHA = { number: 4, title: "Alpha", dueOn: null };
const PLANNED: Backlog = {
  ...EMPTY,
  issues: [
    issue(50, "Epic", { milestone: V2, labels: [IDEA], subIssues: 1 }),
    issue(51, "Ship it", { milestone: V1, labels: [BUG] }),
    // A sub-issue of #50 in another milestone: hidden with the toggle all the same.
    issue(52, "Part of the epic", { milestone: V1, parent: 50 }),
    issue(53, "Someday", { milestone: LATER }),
    issue(54, "Loose end", { labels: [BUG] }),
    issue(55, "First", { milestone: ALPHA }),
    issue(56, "Fix the docs", { milestone: V1, labels: [IDEA] }),
  ],
};
const sectionsOf = (area: HTMLElement) =>
  within(area)
    .getAllByRole("button", { expanded: true })
    .concat(within(area).queryAllByRole("button", { expanded: false }))
    .filter((b) => b.closest("h3"))
    .map((b) => b.textContent);
const header = (area: HTMLElement, name: RegExp) =>
  within(area)
    .getAllByRole("button", { name })
    .find((b) => b.closest("h3"))!;

test("milestoneSections: dated by due date, then undated by title, then No milestone", () => {
  const sections = milestoneSections(PLANNED.issues);
  expect(sections.map((s) => [s.key, s.issues.map((i) => i.number)])).toEqual([
    [1, [51, 52, 56]],
    [2, [50]],
    [4, [55]],
    [3, [53]],
    [NO_MILESTONE, [54]],
  ]);
  expect(sections.at(-1)!.milestone).toBeNull();
  // On what the filters leave: a milestone none of them is in has no section.
  const bugs = milestoneSections(narrowBacklog(PLANNED.issues, ["bug"], false));
  expect(bugs.map((s) => s.key)).toEqual([1, NO_MILESTONE]);
  expect(milestoneSections(narrowBacklog(PLANNED.issues, [], true))[0].issues).toEqual([
    PLANNED.issues[1],
    PLANNED.issues[6],
  ]);
  expect(milestoneSections([])).toEqual([]);
});

test("Group by milestone: offered with a milestone, a section each with its due date and count; kept", async () => {
  backlog = PLANNED;
  const { area } = await open();
  const toggle = within(area).getByRole("button", { name: "Group by milestone" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  // Off: the list as it was, no header.
  expect(numbers(area)).toEqual([50, 51, 52, 53, 54, 55, 56]);
  expect(within(area).queryByRole("heading")).toBeNull();
  fireEvent.click(toggle);
  expect(localStorage.getItem("deckhand.backlog.byMilestone")).toBe("1");
  expect(numbers(area)).toEqual([51, 52, 56, 50, 55, 53, 54]);
  expect(sectionsOf(area)).toEqual([
    "v1due Dec 1, 20263",
    "v2due Jan 15, 20271",
    "Alpha1",
    "Later1",
    "No milestone1",
  ]);
  // The tab's count stays the total.
  expect(backlogTab().textContent).toMatch(/7$/);
  // The filters apply inside: an empty section goes.
  fireEvent.click(within(area).getByRole("button", { name: "Hide sub-issues" }));
  expect(numbers(area)).toEqual([51, 56, 50, 55, 53, 54]);
  fireEvent.input(within(area).getByRole("textbox", { name: "Filter the backlog" }), {
    target: { value: "s" },
  });
  expect(sectionsOf(area)).toEqual(["v1due Dec 1, 20262", "Alpha1", "Later1", "No milestone1"]);
  fireEvent.input(within(area).getByRole("textbox", { name: "Filter the backlog" }), {
    target: { value: "nothing like it" },
  });
  expect(numbers(area)).toEqual([]);
  expect(within(area).getByText("No open issue matches.")).toBeTruthy();
});

test("Group by milestone: not offered without a milestone, the list flat even when on", async () => {
  localStorage.setItem("deckhand.backlog.byMilestone", "1");
  const { area } = await open();
  expect(within(area).queryByRole("button", { name: "Group by milestone" })).toBeNull();
  expect(within(area).queryByRole("heading")).toBeNull();
  expect(numbers(area)).toEqual([40, 41, 42, 43, 44, 45]);
});

test("a section collapses from its header, kept per repo; milestones gone drop out", async () => {
  backlog = PLANNED;
  localStorage.setItem("deckhand.backlog.byMilestone", "1");
  localStorage.setItem("deckhand.backlog.collapsed.acme/app", JSON.stringify([99]));
  const { area } = await open();
  const v1 = header(area, /^v1/);
  expect(v1.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(v1.getAttribute("aria-controls")!)).toBeTruthy();
  fireEvent.click(v1);
  expect(header(area, /^v1/).getAttribute("aria-expanded")).toBe("false");
  expect(numbers(area)).toEqual([50, 55, 53, 54]);
  fireEvent.click(header(area, /^No milestone/));
  expect(numbers(area)).toEqual([50, 55, 53]);
  // #99 isn't listed any more: left out.
  expect(JSON.parse(localStorage.getItem("deckhand.backlog.collapsed.acme/app")!)).toEqual([
    1,
    NO_MILESTONE,
  ]);
  expect(localStorage.getItem("deckhand.backlog.collapsed.acme/other")).toBeNull();
  // The arrows skip a collapsed section's cards.
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    const n = (document.activeElement as HTMLElement | null)?.dataset.number;
    if (n) seen.add(n);
  }
  for (const n of ["51", "52", "56", "54"]) expect(seen.has(n)).toBe(false);
  expect(seen.has("50")).toBe(true);
  fireEvent.click(header(area, /^v1/));
  fireEvent.click(header(area, /^No milestone/));
  expect(numbers(area)).toEqual([51, 52, 56, 50, 55, 53, 54]);
  expect(localStorage.getItem("deckhand.backlog.collapsed.acme/app")).toBeNull();
});

test("a phone: the toggle and the sections in the sheet, its rows' buttons as they were", async () => {
  phone = true;
  backlog = PLANNED;
  const { area } = await open();
  fireEvent.click(within(area).getByRole("button", { name: "Group by milestone" }));
  expect(numbers(area)).toEqual([51, 52, 56, 50, 55, 53, 54]);
  const card = within(area).getByText("Ship it").closest("li")!;
  expect(within(card).getByRole("button", { name: "Start #51" })).toBeTruthy();
  fireEvent.click(header(area, /^v2/));
  expect(numbers(area)).toEqual([51, 52, 56, 55, 53, 54]);
});
