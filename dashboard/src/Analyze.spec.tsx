// The top bar's Analyze dialog against a fake API: the repos, the preview as the selection
// changes, a started analysis and its run, a refusal.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { makeState, makeTask, mockApi, running } from "./testUtils";
import type { State, Task } from "./types";

let previews: string[];
let api: ReturnType<typeof mockApi>;
// The largest count the listener takes (listener/analysis.mjs MAX_RUNS).
let max: number;
beforeEach(() => {
  previews = [];
  max = 50;
  // The preview of the repos the tests pick.
  const preview = ({ url }: { url: string }) => {
    const analyze = /^api\/repos\/(.+)\/analyze(\?.*)$/.exec(url)!;
    previews.push(`${analyze[1]}${analyze[2]}`);
    const query = new URLSearchParams(analyze[2]);
    const kinds = query.get("kinds")!.split(",").filter(Boolean);
    const outcomes = query.get("outcomes")!.split(",").filter(Boolean);
    // A run per kind and outcome picked, up to the count.
    const n = Math.min(Number(query.get("count")), kinds.length * outcomes.length);
    return {
      runs: Array.from({ length: n }, (_, i) => `r${i}`),
      included: n,
      left: n > 4 ? 1 : 0,
      bytes: n * 4000,
      tokens: n * 1000,
      kinds: ["bug", "audit", "work"],
      max,
    };
  };
  api = mockApi({
    "api/repos/acme/api/analyze": preview,
    "api/repos/acme/app/analyze": preview,
    "POST api/repos/acme/app/analyze": ({ body }) =>
      body.count === 13
        ? Response.json({ error: "acme/app has issues turned off." }, { status: 409 })
        : {
            message: "Analysis of 3 runs started on #31.",
            url: "https://github.com/acme/app/issues/31",
            number: 31,
            task: "acme/app#31",
          },
  });
});

const analysisTask = (runs: string[]): Task =>
  makeTask({
    number: 31,
    title: "Run analysis: last 3 runs",
    mode: "analyze",
    runs: running(runs),
  });

const stateWith = (tasks: Task[] = []): State =>
  makeState({ inboxes: { "acme/other": { ideas: null, bugs: null, discussions: null } } }, tasks);

const openDialog = (state: State, hash = "#/all") => {
  history.replaceState(null, "", hash);
  const view = render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
  return { view, dialog: screen.getByRole("dialog", { name: "Analyze runs" }) };
};

const status = (dialog: HTMLElement) => within(dialog).getByRole("status").textContent;

test("Analyze offers the repos the user sees, the open tab's first, and their run kinds", async () => {
  const { dialog } = openDialog(stateWith(), "#/acme/api");
  const repo = within(dialog).getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
  expect([...repo.options].map((o) => o.value)).toEqual([
    "acme/api",
    "acme/app",
    "acme/notes",
    "acme/other",
  ]);
  expect(repo.value).toBe("acme/api");
  // The kinds the listener says the repo's runs have, all picked; every outcome too.
  await waitFor(() => expect(status(dialog)).toMatch(/^10 runs match/));
  const kinds = within(dialog).getByRole("group", { name: "Kinds" });
  const boxes = within(kinds).getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((b) => [b.parentElement!.textContent, b.checked])).toEqual([
    ["Bug", true],
    ["audit", true],
    ["Work", true],
  ]);
  const outcomes = within(dialog).getByRole("group", { name: "Outcomes" });
  expect(
    within(outcomes)
      .getAllByRole("checkbox")
      .every((b) => (b as HTMLInputElement).checked),
  );
  expect(previews.at(-1)).toBe(
    "acme/api?count=10&kinds=bug%2Caudit%2Cwork&outcomes=ok%2Cerror%2Cneeds-input%2Cinterrupted%2Ccancelled",
  );
  expect(status(dialog)).toBe(
    "10 runs match, about 10,000 tokens to read. 1 older run left out: over the digest's cap.",
  );
  expect(within(dialog).getByText(/uses the operator's Claude budget/)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Analyze 10 runs" })).toBeTruthy();
});

test("the preview follows the selection; none matching, or a bad count, can't start", async () => {
  const { dialog } = openDialog(stateWith(), "#/acme/app");
  await waitFor(() => expect(status(dialog)).toMatch(/^10 runs match/));
  const outcomes = within(dialog).getByRole("group", { name: "Outcomes" });
  for (const name of ["Success", "Needs input", "Interrupted", "Cancelled"]) {
    fireEvent.click(within(outcomes).getByRole("checkbox", { name }));
  }
  const kinds = within(dialog).getByRole("group", { name: "Kinds" });
  fireEvent.click(within(kinds).getByRole("checkbox", { name: "audit" }));
  // Work and Bug, errors only: 2 runs.
  await waitFor(() => expect(status(dialog)).toBe("2 runs match, about 2,000 tokens to read."));
  expect(previews.at(-1)).toBe("acme/app?count=10&kinds=bug%2Cwork&outcomes=error");
  fireEvent.click(within(outcomes).getByRole("checkbox", { name: "Error" }));
  await waitFor(() => expect(status(dialog)).toMatch(/^No run matches/));
  const button = within(dialog).getByRole("button", { name: "Analyze" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(within(outcomes).getByRole("checkbox", { name: "Error" }));
  fireEvent.input(within(dialog).getByRole("spinbutton", { name: /Runs to read/ }), {
    target: { value: "51" },
  });
  await waitFor(() => expect(status(dialog)).toBe("Pick from 1 to 50 runs."));
  expect(
    (within(dialog).getByRole("button", { name: /^Analyze/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("Analyze N runs starts it, then links its issue and its run", async () => {
  const { dialog, view } = openDialog(stateWith(), "#/acme/app");
  fireEvent.input(within(dialog).getByRole("spinbutton", { name: /Runs to read/ }), {
    target: { value: "3" },
  });
  await waitFor(() => expect(status(dialog)).toMatch(/^3 runs match/));
  fireEvent.click(within(dialog).getByRole("button", { name: "Analyze 3 runs" }));
  await waitFor(() => expect(within(dialog).getByText(/Started/)).toBeTruthy());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/app/analyze",
      body: {
        count: 3,
        kinds: ["bug", "audit", "work"],
        outcomes: ["ok", "error", "needs-input", "interrupted", "cancelled"],
      },
    },
  ]);
  expect(within(dialog).getByRole("link", { name: "issue #31" }).getAttribute("href")).toBe(
    "https://github.com/acme/app/issues/31",
  );
  view.rerender(<Dashboard state={stateWith([analysisTask(["a1"])])} error={null} />);
  expect(
    within(screen.getByRole("dialog"))
      .getByRole("link", { name: "its run (running)" })
      .getAttribute("href"),
  ).toBe("#/acme/app?task=acme%2Fapp%2331&run=a1");
});

test("a refusal shows the listener's message", async () => {
  const { dialog } = openDialog(stateWith(), "#/acme/app");
  fireEvent.input(within(dialog).getByRole("spinbutton", { name: /Runs to read/ }), {
    target: { value: "13" },
  });
  await waitFor(() => expect(status(dialog)).toMatch(/^13 runs match/));
  fireEvent.click(within(dialog).getByRole("button", { name: "Analyze 13 runs" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toBe("acme/app has issues turned off."),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the count's limit is the listener's", async () => {
  max = 30;
  const { dialog } = openDialog(stateWith(), "#/acme/app");
  await waitFor(() => expect(within(dialog).getByText("the most recent, 30 at most")).toBeTruthy());
  fireEvent.input(within(dialog).getByRole("spinbutton", { name: /Runs to read/ }), {
    target: { value: "40" },
  });
  await waitFor(() => expect(status(dialog)).toBe("Pick from 1 to 30 runs."));
});
