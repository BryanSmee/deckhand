// The inbox form against a fake API: what it offers, a sent entry and its run, a refusal.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { INBOX_DOCS, Inbox } from "./Inbox";
import type { Task } from "./types";

let posted: unknown[];
beforeEach(() => {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "api/repos/acme/app/inbox" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (body.text.includes("refuse")) {
        return Response.json({ error: "acme/app has no bug inbox." }, { status: 409 });
      }
      const n = body.kind === "bug" ? 5 : 4;
      return Response.json({
        message: `Sent to #${n}.`,
        url: `https://github.com/acme/app/issues/${n}#issuecomment-9`,
        task: `acme/app#${n}`,
      });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// The bugs inbox's task, #5.
const inboxTask = (runs: string[]): Task =>
  ({
    key: "acme/app#5",
    repo: "acme/app",
    project: "app",
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

test("only the inboxes the repo has are offered", () => {
  render(<Inbox repo="acme/app" inboxes={{ ideas: 4, bugs: null }} tasks={[]} />);
  expect(screen.getByRole("radio", { name: "Idea" })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Bug" })).toBeNull();
});

test("a repo with no inbox gets the docs' link; one not read yet, nothing", () => {
  const { unmount } = render(<Inbox repo="acme/app" inboxes={undefined} tasks={[]} />);
  expect(screen.queryByRole("form", { name: "Inbox" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
  unmount();
  render(<Inbox repo="acme/app" inboxes={{ ideas: null, bugs: null }} tasks={[]} />);
  expect(screen.getByRole("link", { name: "Set one up" }).getAttribute("href")).toBe(INBOX_DOCS);
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
});

test("Send posts the kind and text, then links the comment and the entry's run", async () => {
  const onSent = vi.fn();
  const before = [inboxTask(["old"])];
  const { rerender } = render(
    <Inbox repo="acme/app" inboxes={{ ideas: 4, bugs: 5 }} tasks={before} onSent={onSent} />,
  );
  const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Bug" }));
  fireEvent.input(screen.getByRole("textbox", { name: "The bug" }), {
    target: { value: "The log stops" },
  });
  fireEvent.click(send);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Sent"));
  expect(posted).toEqual([{ kind: "bug", text: "The log stops" }]);
  expect(onSent).toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "the comment" }).getAttribute("href")).toBe(
    "https://github.com/acme/app/issues/5#issuecomment-9",
  );
  // Its older run isn't the entry's.
  expect(screen.getByRole("link", { name: "the inbox's task" })).toBeTruthy();
  rerender(
    <Inbox
      repo="acme/app"
      inboxes={{ ideas: 4, bugs: 5 }}
      tasks={[inboxTask(["new", "old"])]}
      onSent={onSent}
    />,
  );
  expect(screen.getByRole("link", { name: "its run (running)" }).getAttribute("href")).toBe(
    "#/acme/app?task=acme%2Fapp%235&run=new",
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

test("a refusal shows the listener's message and keeps the text", async () => {
  render(<Inbox repo="acme/app" inboxes={{ ideas: 4, bugs: 5 }} tasks={[]} />);
  fireEvent.input(screen.getByRole("textbox"), { target: { value: "please refuse" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("acme/app has no bug inbox."),
  );
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("please refuse");
  expect(screen.queryByRole("status")).toBeNull();
});
