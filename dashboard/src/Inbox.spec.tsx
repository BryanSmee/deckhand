// The top bar's inbox dialog against a fake API: what it offers, a sent entry and its run, a
// refusal, repos without an inbox.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import { INBOX_DOCS } from "./Inbox";
import type { Inboxes, State, Task } from "./types";

let posted: [string, unknown][];
beforeEach(() => {
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
    const inbox = /^api\/repos\/(.+)\/inbox$/.exec(url);
    if (inbox && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push([inbox[1], body]);
      if (body.text.includes("refuse")) {
        return Response.json({ error: "The text is over 20000 characters." }, { status: 413 });
      }
      const n = body.kind === "bug" ? 5 : 4;
      return Response.json({
        message: `Sent to #${n}.`,
        url: `https://github.com/${inbox[1]}/issues/${n}#issuecomment-9`,
        task: `${inbox[1]}#${n}`,
      });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// acme/app's bugs inbox task, #5.
const inboxTask = (runs: string[]): Task =>
  ({
    key: "acme/app#5",
    repo: "acme/app",
    project: "acme",
    number: 5,
    title: "Bugs",
    kind: "bug",
    mode: "bug",
    replyTo: 5,
    state: "working",
    since: 0,
    closed: null,
    pr: null,
    rerunnable: false,
    runs: runs.map((id) => ({ id, status: "running", startedAt: 0 })),
  }) as unknown as Task;

const stateWith = (inboxes: Record<string, Inboxes> | undefined, tasks: Task[] = []): State => ({
  ...(fixture as State),
  tasks: [...(fixture as State).tasks, ...tasks],
  inboxes,
});

const INBOXES = {
  "acme/app": { ideas: 4, bugs: 5 },
  "acme/api": { ideas: 7, bugs: null },
  "acme/notes": { ideas: null, bugs: null },
};

const openDialog = (state: State, hash = "#/all") => {
  history.replaceState(null, "", hash);
  const view = render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
  return { view, dialog: screen.getByRole("dialog", { name: "Send feedback" }) };
};

test("the top bar's Feedback offers the repos with an inbox, the open tab's first", () => {
  const { dialog } = openDialog(stateWith(INBOXES), "#/acme/api");
  const repo = within(dialog).getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
  expect([...repo.options].map((o) => o.value)).toEqual(["acme/api", "acme/app"]);
  expect(repo.value).toBe("acme/api");
  // Only the inboxes it has.
  expect(within(dialog).getByRole("radio", { name: "Idea" })).toBeTruthy();
  expect(within(dialog).queryByRole("radio", { name: "Bug" })).toBeNull();
  fireEvent.change(repo, { target: { value: "acme/app" } });
  expect(within(dialog).getByRole("radio", { name: "Bug" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a repo without an inbox, or none at all: the docs' link", () => {
  const { dialog, view } = openDialog(stateWith(INBOXES), "#/acme/notes");
  expect(within(dialog).getByText(/acme\/notes has no inbox/)).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "Set one up" }).getAttribute("href")).toBe(
    INBOX_DOCS,
  );
  view.unmount();
  const none = openDialog(stateWith({ "acme/notes": { ideas: null, bugs: null } })).dialog;
  expect(within(none).getByText(/No repository has an inbox/)).toBeTruthy();
  expect(within(none).queryByRole("button", { name: "Send" })).toBeNull();
});

test("Send posts the kind and text to the repo, then links the comment and the entry's run", async () => {
  const { dialog, view } = openDialog(stateWith(INBOXES, [inboxTask(["old"])]), "#/acme/app");
  const send = within(dialog).getByRole("button", { name: "Send" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("radio", { name: "Bug" }));
  fireEvent.input(within(dialog).getByRole("textbox", { name: "The bug" }), {
    target: { value: "The log stops" },
  });
  fireEvent.click(send);
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("Sent"));
  expect(posted).toEqual([["acme/app", { kind: "bug", text: "The log stops" }]]);
  expect(within(dialog).getByRole("link", { name: "the comment" }).getAttribute("href")).toBe(
    "https://github.com/acme/app/issues/5#issuecomment-9",
  );
  // Its older run isn't the entry's.
  expect(within(dialog).getByRole("link", { name: "the inbox's task" })).toBeTruthy();
  view.rerender(<Dashboard state={stateWith(INBOXES, [inboxTask(["new", "old"])])} error={null} />);
  const dialogNow = screen.getByRole("dialog");
  expect(
    within(dialogNow).getByRole("link", { name: "its run (running)" }).getAttribute("href"),
  ).toBe("#/acme/app?task=acme%2Fapp%235&run=new");
  expect((within(dialogNow).getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

test("a refusal shows the listener's message and keeps the text", async () => {
  const { dialog } = openDialog(stateWith(INBOXES));
  fireEvent.input(within(dialog).getByRole("textbox"), { target: { value: "please refuse" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "The text is over 20000 characters.",
    ),
  );
  expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("please refuse");
  expect(within(dialog).queryByRole("status")).toBeNull();
});
