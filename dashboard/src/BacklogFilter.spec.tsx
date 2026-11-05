// The Backlog tab's filters: its labels, "Hide sub-issues" and the text field together, kept
// in this browser (labels per repository, the toggle for every one).
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { labelCounts, narrowBacklog, NO_LABEL } from "./BacklogFilter";
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
