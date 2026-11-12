// The workflow editor (WorkflowEditor.tsx, WorkflowSteps.tsx): a file beside its graph, checked
// as it is typed; the dry run's replay, divergence and picks; Save as a pull request, only with
// repo:config:write.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { AccessContext, canFrom, EVERYTHING } from "./access";
import { DRY_RUN, WORKFLOW_CHECK, WORKFLOW_FILES } from "./shots";
import { mockApi } from "./testUtils";
import type { WorkflowCheck } from "./types";
import { WorkflowEditor } from "./WorkflowEditor";

beforeEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = "api/repos/acme/app/workflows";

function setup({ check = WORKFLOW_CHECK as WorkflowCheck, can = EVERYTHING } = {}) {
  const api = mockApi({
    [BASE]: () => WORKFLOW_FILES,
    [`POST ${BASE}/check`]: () => check,
    [`POST ${BASE}/dry-run`]: () => DRY_RUN,
    [`POST ${BASE}/save`]: () => ({
      number: 42,
      url: "https://github.example.com/acme/app/pull/42",
      branch: "deckhand-workflow-review-1a2b3c4d",
    }),
  });
  render(
    <AccessContext.Provider value={can}>
      <WorkflowEditor repo="acme/app" now={WORKFLOW_FILES.pulls[0].at + 60_000} />
    </AccessContext.Provider>,
  );
  return api;
}

const graph = () => within(screen.getByRole("list", { name: "The workflow's steps" }));
const text = () =>
  screen.getByRole("textbox", { name: "The workflow's YAML" }) as HTMLTextAreaElement;

test("the file beside its graph, checked: its steps, its loop and branches, who runs it now", async () => {
  const api = setup();
  await waitFor(() => expect(text().value).toBe(WORKFLOW_FILES.files[0].text));
  await screen.findByText("No errors: this is what Deckhand would run once it is merged.");
  expect(api.posted[0].body).toEqual({ name: "review.yaml", text: WORKFLOW_FILES.files[0].text });
  expect(graph().getByText("Repeat, at most 3 rounds of fixes")).toBeTruthy();
  expect(graph().getByText("severity <= low")).toBeTruthy();
  expect(graph().getAllByText("Review")).toHaveLength(3);
  expect(graph().getByText("on codex · best")).toBeTruthy();
  expect(graph().getByText("+1 fixes")).toBeTruthy();
  // 3 on the default branch's version, 1 on an older one.
  expect(
    screen.getByText(/3 open pull requests run the version on the default branch/).textContent,
  ).toContain("1 runs an older version.");
});

test("errors as it is typed, each line a link to it; the last graph stays, faded", async () => {
  const check: WorkflowCheck = {
    steps: null,
    on: [],
    errors: [{ file: null, line: 3, message: "run: unknown step deploy (expected …)" }],
  };
  const api = setup();
  await screen.findByText("No errors: this is what Deckhand would run once it is merged.");
  api.routes[`POST ${BASE}/check`] = () => check;
  fireEvent.input(text(), { target: { value: "on: ready\nsteps:\n  - run: deploy\n" } });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("1 error: none of the repository's workflows would run.");
  fireEvent.click(within(alert).getByRole("button", { name: "line 3" }));
  expect(text().selectionStart).toBe("on: ready\nsteps:\n".length);
  // Still drawn, from the last text that parsed.
  expect(graph().getByText("Repeat, at most 3 rounds of fixes")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open a pull request" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("the dry run: the pull request's history replayed, where it diverged, a pick asked and sent", async () => {
  const api = setup();
  await screen.findByText("No errors: this is what Deckhand would run once it is merged.");
  fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
    target: { value: "212" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replay it" }));
  await screen.findByText("What does Auto-merge (line 18) end with?");
  expect(api.bodies().at(-1)).toEqual({
    name: "review.yaml",
    text: WORKFLOW_FILES.files[0].text,
    pr: 212,
    picks: [],
  });
  expect(
    screen.getByText(/which the pull request never did: its next step was Auto-merge \(Merged\)/),
  ).toBeTruthy();
  expect(screen.getAllByText("as it happened")).toHaveLength(3);
  expect(screen.getAllByText("assumed: CI isn't recorded")).toHaveLength(2);
  // The graph marks the step where it diverged and the one waiting.
  expect(graph().getByText("The pull request never did this")).toBeTruthy();
  expect(graph().getByText("Pick what happens")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not merged" }));
  await waitFor(() => expect(api.bodies().at(-1)).toMatchObject({ picks: ["refused"] }));
});

test("Save opens a pull request once the text changed, and says where", async () => {
  const api = setup();
  await screen.findByText("No errors: this is what Deckhand would run once it is merged.");
  const save = screen.getByRole("button", { name: "Open a pull request" });
  // Unchanged: nothing to save.
  expect(save).toHaveProperty("disabled", true);
  const edited = WORKFLOW_FILES.files[0].text.replace("fixes 3", "fixes 2");
  fireEvent.input(text(), { target: { value: edited } });
  await waitFor(() => expect(api.bodies().at(-1)).toEqual({ name: "review.yaml", text: edited }));
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.click(save);
  const done = await screen.findByText(/opened: merge it to apply the workflow/);
  expect(within(done).getByRole("link", { name: "#42" })).toHaveProperty(
    "href",
    "https://github.example.com/acme/app/pull/42",
  );
  expect(api.bodies().at(-1)).toEqual({
    name: "review.yaml",
    text: edited,
    sha: WORKFLOW_FILES.files[0].sha,
  });
  // Saved as it is: no second pull request for the same change; an edit can be saved again.
  expect(save).toHaveProperty("disabled", true);
  fireEvent.input(text(), { target: { value: `${edited}# more\n` } });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
});

test("without repo:config:write, the dry run still works but Save says what it needs", async () => {
  const can = canFrom({
    server: [],
    repos: {
      "acme/app": {
        actions: ["tasks:read", "repo:config:read"],
        starts: [],
        startsDenied: [],
      },
    },
  });
  setup({ can });
  await screen.findByText("No errors: this is what Deckhand would run once it is merged.");
  fireEvent.input(text(), { target: { value: `${WORKFLOW_FILES.files[0].text}# more\n` } });
  expect(screen.getByRole("button", { name: "Open a pull request" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText(/Saving needs the/).textContent).toContain("repo:config:write");
});

test("a new file starts from Deckhand's own loop, or a starter, under a name it picks", async () => {
  setup();
  await waitFor(() => expect(text().value).toBe(WORKFLOW_FILES.files[0].text));
  fireEvent.change(screen.getByRole("combobox", { name: "Workflow" }), { target: { value: "" } });
  // review.yaml is taken: no name until one is typed.
  expect((screen.getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("");
  expect(text().value).toContain("max: fixes 2");
  expect(screen.getByRole("heading", { name: "New workflow" })).toBeTruthy();
});

test("another file's errors are said, and don't keep this one from being saved", async () => {
  const check: WorkflowCheck = {
    ...WORKFLOW_CHECK,
    errors: [{ file: ".deckhand/workflows/old.yaml", line: 1, message: "on: unknown event nope" }],
  };
  setup({ check });
  const said = await screen.findByText(/Another file has an error/);
  expect(said.closest("[role=status]")!.textContent).toContain(".deckhand/workflows/old.yaml:1");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.input(text(), { target: { value: `${WORKFLOW_FILES.files[0].text}# more\n` } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open a pull request" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  // The dry run, too, needs only this file to parse.
  fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
    target: { value: "212" },
  });
  expect(screen.getByRole("button", { name: "Replay it" })).toHaveProperty("disabled", false);
});

test("a workflow replacing the built-in loop says so; the dry run needs only a text that parses", async () => {
  const api = setup({ check: { ...WORKFLOW_CHECK, replaces: true } });
  await screen.findByText(/replaces Deckhand's built-in review loop/);
  expect(screen.getByText(/replaces Deckhand's built-in review loop/).textContent).toContain(
    "review.on: ready",
  );
  // A trigger clash of its own blocks the save, not the dry run.
  api.routes[`POST ${BASE}/check`] = () => ({
    ...WORKFLOW_CHECK,
    errors: [{ file: null, line: 1, message: "two triggers for ready: …" }],
  });
  fireEvent.input(text(), { target: { value: `${WORKFLOW_FILES.files[0].text}# more\n` } });
  await screen.findByRole("alert");
  fireEvent.change(screen.getByRole("combobox", { name: "Pull request" }), {
    target: { value: "212" },
  });
  expect(screen.getByRole("button", { name: "Replay it" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Open a pull request" })).toHaveProperty(
    "disabled",
    true,
  );
});
