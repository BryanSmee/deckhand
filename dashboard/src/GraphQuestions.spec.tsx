// The graph's work area and an issue waiting for answers: starting or queueing it opens its
// open questions first, and every one needs an answer before it goes (fetch mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import type { Backlog, State } from "./types";

const state = fixture as State;

const BACKLOG: Backlog = { issues: [], modes: ["work", "review"], errors: false, readAt: 0 };

let posted: { url: string; body: unknown }[];
let answer: () => Response;
beforeEach(() => {
  posted = [];
  answer = () => Response.json({ message: "Answers sent: #138 started." });
  history.replaceState(null, "", "#/graph/acme/api");
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "api/repos/acme/api/issues") return Response.json(BACKLOG);
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "api/repos/acme/api/answer") return answer();
      return Response.json({ message: "done" });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const area = async () => {
  render(<Dashboard state={state} error={null} />);
  const work = screen.getByRole("region", { name: "Work area" });
  await within(work).findByText("No open issue left to start.");
  return within(work).getByRole("list", { name: "Issues waiting for answers" });
};

// Every question of the fixture's #138 answered: its two picks are ticked in advance, the
// free-text one is left.
const answerAll = (dialog: HTMLElement) =>
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Answer to question 3" }), {
    target: { value: "No results" },
  });

test("Start on an issue waiting for answers opens its questions; it starts with them", async () => {
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
  const dialog = screen.getByRole("dialog", { name: "Answer #138's questions" });
  expect(within(dialog).getByText("Answer them to start #138")).toBeTruthy();
  const send = within(dialog).getByRole("button", { name: "Send answers and start" });
  // Nothing went yet, and a partial answer can't go: the picks ticked in advance answer two.
  expect(posted).toEqual([]);
  expect((send as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByText("Answer every question to start it (1 left).")).toBeTruthy();
  answerAll(dialog);
  expect((send as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: {
        number: 138,
        answers: [
          { options: [1], text: "" },
          { options: [0], text: "" },
          { options: [], text: "No results" },
        ],
        then: { action: "start" },
      },
    },
  ]);
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Answers sent: #138 started.",
  );
});

test("Queue after… sends the queue along; a refusal stays in the form", async () => {
  answer = () => Response.json({ error: "#141 was closed without being done." }, { status: 422 });
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "After…" }));
  fireEvent.change(within(list).getByRole("combobox", { name: "Queue #138 after" }), {
    target: { value: "141" },
  });
  fireEvent.click(within(list).getByRole("button", { name: "Queue" }));
  const dialog = screen.getByRole("dialog", { name: "Answer #138's questions" });
  expect(within(dialog).getByText("Answer them to queue #138 after #141")).toBeTruthy();
  answerAll(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers and queue" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty(
    "textContent",
    "#141 was closed without being done.",
  );
  expect(posted[0].body).toMatchObject({ number: 138, then: { action: "queue", after: 141 } });
});

test("Cancel or Escape closes the questions: nothing is sent", async () => {
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(posted).toEqual([]);
});
