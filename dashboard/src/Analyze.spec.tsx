// The top bar's Analyze dialog against a fake API: the repos, the preview as the selection
// changes, a started analysis and its run, a refusal.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import type { State, Task } from "./types";

let previews: string[];
let posted: [string, unknown][];
beforeEach(() => {
  previews = [];
  posted = [];
  history.replaceState(null, "", "/");
  Object.assign(globalThis, {
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const analyze = /^api\/repos\/(.+)\/analyze(\?.*)?$/.exec(url);
    if (analyze && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push([analyze[1], body]);
      if (body.count === 13) {
        return Response.json({ error: "acme/app has issues turned off." }, { status: 409 });
      }
      return Response.json({
        message: "Analysis of 3 runs started on #31.",
        url: `https://github.com/${analyze[1]}/issues/31`,
        number: 31,
        task: `${analyze[1]}#31`,
      });
    }
    if (analyze) {
      previews.push(`${analyze[1]}${analyze[2]}`);
      const query = new URLSearchParams(analyze[2]);
      const kinds = query.get("kinds")!.split(",").filter(Boolean);
      const outcomes = query.get("outcomes")!.split(",").filter(Boolean);
      // A run per kind and outcome picked, up to the count.
      const n = Math.min(Number(query.get("count")), kinds.length * outcomes.length);
      return Response.json({
        runs: Array.from({ length: n }, (_, i) => `r${i}`),
        included: n,
        left: n > 4 ? 1 : 0,
        bytes: n * 4000,
        tokens: n * 1000,
        kinds: ["bug", "review", "work"],
        max: 50,
      });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const analysisTask = (runs: string[]): Task =>
  ({
    key: "acme/app#31",
    repo: "acme/app",
    project: "acme",
    number: 31,
    title: "Run analysis: last 3 runs",
    kind: "issue",
    mode: "analyze",
    replyTo: 31,
    state: "working",
    since: 0,
    closed: null,
    pr: null,
    rerunnable: false,
    runs: runs.map((id) => ({ id, status: "running", startedAt: 0 })),
  }) as unknown as Task;

const stateWith = (tasks: Task[] = []): State => ({
  ...(fixture as State),
  tasks: [...(fixture as State).tasks, ...tasks],
  inboxes: { "acme/other": { ideas: null, bugs: null, discussions: null } },
});

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
    ["review", true],
    ["Work", true],
  ]);
  const outcomes = within(dialog).getByRole("group", { name: "Outcomes" });
  expect(
    within(outcomes)
      .getAllByRole("checkbox")
      .every((b) => (b as HTMLInputElement).checked),
  );
  expect(previews.at(-1)).toBe(
    "acme/api?count=10&kinds=bug%2Creview%2Cwork&outcomes=ok%2Cerror%2Cneeds-input%2Cinterrupted%2Ccancelled",
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
  fireEvent.click(within(kinds).getByRole("checkbox", { name: "review" }));
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
  expect(posted).toEqual([
    [
      "acme/app",
      {
        count: 3,
        kinds: ["bug", "review", "work"],
        outcomes: ["ok", "error", "needs-input", "interrupted", "cancelled"],
      },
    ],
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
