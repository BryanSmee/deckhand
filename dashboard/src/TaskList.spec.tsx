// The task list's search and state chips: they filter together, and each chip counts the
// rows it would show; "/" goes to the search box, a phone opens it from its top bar.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { type ChipId, matchesSearch } from "./format";
import { TaskList } from "./TaskList";
import { makeState, makeTask } from "./testUtils";

const state = makeState();

// The list as App keeps it: its chip and query in state.
function List({ touch = false }: { touch?: boolean }) {
  const [chip, setChip] = useState<ChipId>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!touch);
  return (
    <TaskList
      tasks={state.tasks}
      chip={chip}
      onChip={setChip}
      query={query}
      onQuery={setQuery}
      searching={open}
      onSearching={setOpen}
      selected={null}
      onSelect={() => {}}
      showRepo
      now={state.now}
      loading={false}
      touch={touch}
    />
  );
}

const rows = () =>
  within(screen.getByRole("list"))
    .getAllByRole("button")
    .map((b) => b.querySelector("span:nth-child(2)")!.textContent);
// "Running 3" → ["Running", 3]
const chips = () =>
  within(screen.getByRole("group", { name: "State" }))
    .getAllByRole("button")
    .map((b) => [b.firstChild!.textContent, Number(b.lastChild!.textContent)]);
const search = () => screen.getByRole("searchbox", { name: "Search tasks" });
const type = (text: string) => fireEvent.input(search(), { target: { value: text } });

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});

test("the chips: All, Running, Needs you, Ready, Done, Error, each with its count", () => {
  render(<List />);
  expect(chips()).toEqual([
    ["All", 11],
    ["Running", 4],
    ["Needs you", 3],
    ["Ready", 2],
    ["Done", 2],
    ["Error", 2],
  ]);
});

test("search and chips filter together, and the counts are what the search finds", () => {
  render(<List />);
  type("budgets");
  expect(rows()).toEqual(["Per-repo budgets for runs", "Per-repo budgets in the dashboard"]);
  expect(chips()).toEqual([
    ["All", 2],
    ["Running", 2],
    ["Needs you", 0],
    ["Ready", 0],
    ["Done", 0],
    ["Error", 0],
  ]);
  // A chip's count is the rows it shows.
  for (const [name, count] of chips()) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
    const shown = screen.queryByRole("list") ? rows().length : 0;
    expect(shown, String(name)).toBe(count);
  }
  expect(screen.getByText("Nothing in this state")).toBeTruthy();

  // By repository, then by number.
  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  type("acme/notes");
  expect(rows()).toEqual([
    "How do runs restart after an update?",
    "Weekly digest of merged pull requests",
  ]);
  type("#16");
  expect(rows()).toEqual(["Bugs"]);
  type("nothing like it");
  expect(screen.getByText("No task matches “nothing like it”")).toBeTruthy();
  // Escape empties it.
  fireEvent.keyDown(search(), { key: "Escape" });
  expect(rows()).toHaveLength(11);
});

test("matchesSearch: every word, in the title, number, pull request or repo", () => {
  const t = makeTask({ repo: "acme/app", number: 22, title: "Dashboard on Vite" });
  expect(matchesSearch(t, "")).toBe(true);
  expect(matchesSearch(t, "vite dashboard")).toBe(true);
  expect(matchesSearch(t, "#22")).toBe(true);
  expect(matchesSearch(t, "acme/app")).toBe(true);
  expect(matchesSearch(t, "vite react")).toBe(false);
  expect(matchesSearch(t, "#23")).toBe(false);
  const pr = { ...t, pr: { ...state.tasks[0].pr!, number: 34 } };
  expect(matchesSearch(pr, "#34")).toBe(true);
});

test("/ goes to the search box, but not while typing elsewhere", () => {
  render(
    <>
      <input aria-label="Elsewhere" />
      <List />
    </>,
  );
  const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
  elsewhere.focus();
  fireEvent.keyDown(elsewhere, { key: "/" });
  expect(document.activeElement).toBe(elsewhere);
  elsewhere.blur();
  fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(search());
});

test("on a phone: the top bar's search button opens the box, and closes it emptied", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  history.replaceState(null, "", "#/acme/app");
  render(<Dashboard state={state} error={null} />);
  expect(screen.queryByRole("searchbox")).toBeNull();
  const button = screen.getByRole("button", { name: "Search tasks" });
  fireEvent.click(button);
  expect(document.activeElement).toBe(search());
  type("bugs");
  expect(rows()).toEqual(["Bugs"]);
  fireEvent.click(button);
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(rows()).toHaveLength(5);
});
