// The top bar's inbox dialog against a fake API: what it offers, a sent entry and its run, a
// refusal, repos without an inbox.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { INBOX_DOCS } from "./Inbox";
import { makeState, makeTask, mockApi, running } from "./testUtils";
import type { Inboxes, State, Task } from "./types";

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi();
  // Any repo's inbox or discussions.
  api.answer = ({ url, body }) => {
    const started = /^api\/repos\/(.+)\/discussions$/.exec(url);
    if (started) {
      if (body.title.includes("refuse")) {
        return Response.json(
          { error: 'acme/app has no discussion category "ask claude": create it.' },
          { status: 409 },
        );
      }
      return {
        message: "Discussion #9 started.",
        url: `https://github.com/${started[1]}/discussions/9`,
        number: 9,
        task: `${started[1]}#discussion-9`,
      };
    }
    const inbox = /^api\/repos\/(.+)\/inbox$/.exec(url);
    if (inbox) {
      if (body.text.includes("refuse")) {
        return Response.json({ error: "The text is over 20000 characters." }, { status: 413 });
      }
      const n = body.kind === "bug" ? 5 : 4;
      return {
        message: `Sent to #${n}.`,
        url: `https://github.com/${inbox[1]}/issues/${n}#issuecomment-9`,
        task: `${inbox[1]}#${n}`,
      };
    }
    return new Response("{}", { status: 404 });
  };
});

// acme/app's bugs inbox task, #5.
const inboxTask = (runs: string[]): Task =>
  makeTask({ number: 5, title: "Bugs", kind: "bug", mode: "bug", runs: running(runs) });

const stateWith = (inboxes: Record<string, Inboxes> | undefined, tasks: Task[] = []): State =>
  makeState({ inboxes }, tasks);

const INBOXES = {
  "acme/app": { ideas: 4, bugs: 5, discussions: "ask claude" },
  "acme/api": { ideas: 7, bugs: null, discussions: null },
  "acme/notes": { ideas: null, bugs: null, discussions: null },
};

const openDialog = (state: State, hash = "#/") => {
  history.replaceState(null, "", hash);
  const view = render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "New request" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Idea or bug report" }));
  return { view, dialog: screen.getByRole("dialog", { name: "Send feedback" }) };
};

test("New request's Feedback offers the repos with an inbox, the open tab's first", () => {
  const { dialog } = openDialog(stateWith(INBOXES), "#/acme/api");
  const repo = within(dialog).getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
  expect([...repo.options].map((o) => o.value)).toEqual(["acme/api", "acme/app"]);
  expect(repo.value).toBe("acme/api");
  // Only the inboxes it has.
  expect(within(dialog).getByRole("radio", { name: "Idea" })).toBeTruthy();
  expect(within(dialog).queryByRole("radio", { name: "Bug" })).toBeNull();
  expect(within(dialog).queryByRole("radio", { name: "Discussion" })).toBeNull();
  fireEvent.change(repo, { target: { value: "acme/app" } });
  expect(within(dialog).getByRole("radio", { name: "Bug" })).toBeTruthy();
  expect(within(dialog).getByRole("radio", { name: "Discussion" })).toBeTruthy();
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
  const none = openDialog(
    stateWith({ "acme/notes": { ideas: null, bugs: null, discussions: null } }),
  ).dialog;
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
  expect(api.posted).toEqual([
    { url: "api/repos/acme/app/inbox", body: { kind: "bug", text: "The log stops" } },
  ]);
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

test("a discussion: a title and a text, started in the repo's category, then its thread", async () => {
  const { dialog, view } = openDialog(stateWith(INBOXES), "#/acme/app");
  fireEvent.click(within(dialog).getByRole("radio", { name: "Discussion" }));
  const start = within(dialog).getByRole("button", { name: "Start" }) as HTMLButtonElement;
  fireEvent.input(within(dialog).getByRole("textbox", { name: "The discussion" }), {
    target: { value: "Is the queue kept?" },
  });
  // Not without a title.
  expect(start.disabled).toBe(true);
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Title" }), {
    target: { value: "Restarts" },
  });
  fireEvent.click(start);
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("Sent"));
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/app/discussions",
      body: { title: "Restarts", body: "Is the queue kept?" },
    },
  ]);
  expect(within(dialog).getByRole("link", { name: "the discussion" }).getAttribute("href")).toBe(
    "https://github.com/acme/app/discussions/9",
  );
  // Its task, once api/state lists it.
  const task = {
    ...inboxTask(["d1"]),
    key: "acme/app#discussion-9",
    number: 9,
    kind: "discussion",
  } as Task;
  view.rerender(<Dashboard state={stateWith(INBOXES, [task])} error={null} />);
  expect(
    within(screen.getByRole("dialog"))
      .getByRole("link", { name: "its thread" })
      .getAttribute("href"),
  ).toBe("#/acme/app?task=acme%2Fapp%23discussion-9");
});

test("a discussion refused: the listener's message, the title and text kept", async () => {
  const { dialog } = openDialog(stateWith(INBOXES), "#/acme/app");
  fireEvent.click(within(dialog).getByRole("radio", { name: "Discussion" }));
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Title" }), {
    target: { value: "please refuse" },
  });
  fireEvent.input(within(dialog).getByRole("textbox", { name: "The discussion" }), {
    target: { value: "Hello" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/create it/));
  expect((within(dialog).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe(
    "please refuse",
  );
});
