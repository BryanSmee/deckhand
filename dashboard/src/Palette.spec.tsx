// Ctrl K, "Jump to": a task found by its number or its title's words across repositories,
// opened with Enter or on GitHub with Ctrl Enter; repositories, lanes and actions.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { mockApi, makeState } from "./testUtils";

const state = makeState({ inboxes: { "acme/app": { ideas: 5, bugs: 6, discussions: null } } });

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({ "POST api/sync": () => ({ at: 1, redelivered: 0, pulls: 0, conflicts: 0 }) });
  history.replaceState(null, "", "#/");
});

const open = () => {
  render(<Dashboard state={state} error={null} />);
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  return screen.getByRole("combobox", { name: "Jump to a repository, task or action" });
};
const type = (box: HTMLElement, value: string) => fireEvent.input(box, { target: { value } });
const options = () =>
  within(screen.getByRole("listbox", { name: "Results" }))
    .getAllByRole("option")
    .map((o) => o.textContent);
const selected = () =>
  within(screen.getByRole("listbox")).getByRole("option", { selected: true }).textContent;

test("a number finds its task first; Enter opens it", () => {
  const box = open();
  expect(document.activeElement).toBe(box);
  type(box, "#23");
  expect(selected()).toMatch(/^#23 Per-repo budgets for runs · acme\/app/);
  fireEvent.keyDown(box, { key: "Enter" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(location.hash).toBe("#/acme/app?task=acme%2Fapp%2323");
});

test("title words find tasks in every repo, marked; the arrows move; Ctrl Enter opens GitHub", () => {
  const github = vi.spyOn(window, "open").mockReturnValue(null);
  const box = open();
  type(box, "budgets dashboard");
  expect(options()[0]).toMatch(/^#24 Per-repo budgets in the dashboard/);
  expect(
    [...screen.getAllByRole("option")[0].querySelectorAll("mark")].map((m) => m.textContent),
  ).toEqual(["budgets", "dashboard"]);
  type(box, "flicker");
  expect(selected()).toMatch(/Search results flicker when typing fast · acme\/api/);
  fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
  expect(github).toHaveBeenCalledWith(
    "https://github.example.com/acme/api/issues/138",
    "_blank",
    "noreferrer",
  );
  expect(location.hash).toBe("#/");
});

test("repositories, then the actions; an idea takes what was typed as its title", () => {
  const box = open();
  type(box, "notes");
  expect(options()).toContain("acme/notes");
  fireEvent.keyDown(box, { key: "ArrowDown" });
  type(box, "acme/notes");
  const all = options();
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "ArrowUp" });
  expect(selected()).toBe(all[0]);
  type(box, "Retry the inbox");
  const idea = screen.getByRole("option", { name: /New idea: “Retry the inbox”/ });
  fireEvent.click(idea);
  const dialog = screen.getByRole("dialog", { name: "New request" });
  expect(
    within(dialog).getByDisplayValue("Retry the inbox", { exact: true }) as HTMLInputElement,
  ).toBeTruthy();
});

test("the theme and Sync are actions too", async () => {
  const box = open();
  // "dark" alone finds "Dark mode for the settings page" first.
  type(box, "theme: dark");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(localStorage.getItem("deckhand.theme")).toBe("dark");
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const again = screen.getByRole("combobox", { name: /Jump to/ });
  type(again, "sync with");
  expect(selected()).toBe("Sync with GitHub");
  fireEvent.keyDown(again, { key: "Enter" });
  // The sidebar's Sync runs, and says how it went.
  await waitFor(() => expect(api.posted.map((p) => p.url)).toEqual(["api/sync"]));
  expect(await screen.findByText("Up to date with GitHub")).toBeTruthy();
});

test("Sync from the board, its sidebar a rail: it runs, and a note says how it went", async () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("button", { name: "Expand the sidebar" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const box = screen.getByRole("combobox", { name: /Jump to/ });
  type(box, "sync with");
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(api.posted.map((p) => p.url)).toEqual(["api/sync"]));
  expect((await screen.findByRole("status")).textContent).toBe("Up to date with GitHub");
});

test("a lane: the board's lanes view, on that lane", async () => {
  const box = open();
  type(box, "#22 and");
  const lane = screen.getByRole("option", {
    name: /Show the #22 and 2 more lane on acme\/app's board/,
  });
  fireEvent.click(lane);
  expect(location.hash).toBe("#/acme/app/board");
  expect(localStorage.getItem("deckhand.boardView")).toBe("lanes");
  // Found by any of its issues, and its first card selected.
  const shown = await screen.findByRole("region", { name: "Lane #22 and 2 more" });
  await waitFor(() => expect(shown.contains(document.activeElement)).toBe(true));
});
