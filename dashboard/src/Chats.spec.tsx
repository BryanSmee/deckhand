// The Chats page (#477): the list and its limit, New chat, the conversation from its runs' logs,
// sending (Enter, Shift Enter), messages queued while the sandbox resumes, Reset and Delete
// (fetch and the log streams mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { chatState, runTurns } from "./chatModel";
import { FakeSource, makeChat, makeChats, makeState, mockApi } from "./testUtils";
import type { Chat, Chats, Entry, Run } from "./types";

const state = makeState();

beforeEach(() => {
  FakeSource.last = null;
  FakeSource.opened = [];
  vi.stubGlobal("EventSource", FakeSource);
  history.replaceState(null, "", "#/chats");
});

// A chat's run, as publicRun() lists it.
// New chat, once the list is read.
const newChat = async () => {
  const button = await screen.findByRole("button", { name: "New chat" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
};

const chatRun = (partial: Partial<Run> = {}): Run => ({
  id: "deckhand-acme-app-chat-1",
  key: "acme/app#chat-0123456789abcdef",
  kind: null,
  title: null,
  repo: "acme/app",
  replyTo: null,
  mode: "start",
  taskMode: "chat",
  startedAt: 1_000,
  finishedAt: null,
  status: "running",
  phase: "work",
  ...partial,
});

// The page over a listener whose api/chats answers `list` (changed by the POSTs' handlers).
function show(list: Chats, routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ "api/chats": () => list, ...routes });
  render(<Dashboard state={state} error={null} />);
  return api;
}

test("the list: the chats with how many the user keeps, the sidebar's link, a chat opened", async () => {
  show(makeChats([makeChat(), makeChat({ id: "fedcba9876543210", title: "Try the build" })]));
  const nav = await screen.findByRole("link", { name: /Chats\s*2 of 4/ });
  expect(nav.getAttribute("aria-current")).toBe("page");
  const list = screen.getByRole("complementary", { name: "Your chats" });
  expect(within(list).getByRole("heading", { name: /Chats\s*2 of 4/ })).toBeTruthy();
  fireEvent.click(within(list).getByRole("link", { name: /Try the build/ }));
  await waitFor(() => expect(location.hash).toBe("#/chats/fedcba9876543210"));
  const chat = await screen.findByRole("region", { name: "Try the build" });
  expect(within(chat).getByText("acme/app")).toBeTruthy();
  expect(within(chat).getByText("Stopped")).toBeTruthy();
});

test("the limit: New chat disabled past it, with the reason", async () => {
  const kept = [0, 1, 2, 3].map((n) => makeChat({ id: `${n}`.repeat(16), title: `Chat ${n}` }));
  show(makeChats(kept));
  expect(
    await screen.findByText(
      "You keep 4 of 4 chats, the most you may: delete one to start another.",
    ),
  ).toBeTruthy();
  const button = screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

test("New chat: the repository, agent, model and effort, and a first message; it opens", async () => {
  const list = makeChats();
  const made = makeChat({ id: "aaaaaaaaaaaaaaaa", status: "running", title: "Hi" });
  const api = show(list, {
    "POST api/chats": () => {
      list.chats = [made];
      return { chat: made };
    },
  });
  await newChat();
  const dialog = screen.getByRole("dialog", { name: "New chat" });
  const repo = within(dialog).getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
  // Only those whose `users` include the user (the listener's `repos`).
  expect([...repo.options].map((o) => o.value)).toEqual(["acme/api", "acme/app"]);
  fireEvent.change(repo, { target: { value: "acme/app" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Agent" }), {
    target: { value: "claude@anthropic" },
  });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Model" }), {
    target: { value: "fast" },
  });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Effort" }), {
    target: { value: "high" },
  });
  fireEvent.input(within(dialog).getByRole("textbox", { name: "First message" }), {
    target: { value: "  Hi  " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start the chat" }));
  await waitFor(() => expect(location.hash).toBe("#/chats/aaaaaaaaaaaaaaaa"));
  expect(api.posted).toEqual([
    {
      url: "api/chats",
      body: {
        repo: "acme/app",
        agent: "claude@anthropic",
        model: "fast",
        effort: "high",
        message: "Hi",
      },
    },
  ]);
  expect(screen.queryByRole("dialog", { name: "New chat" })).toBeNull();
  expect(await screen.findByRole("heading", { name: "Hi", level: 2 })).toBeTruthy();
});

test("New chat refused: the listener's reason, the dialog kept", async () => {
  show(makeChats(), {
    "POST api/chats": () =>
      Response.json({ error: "You can't do this on acme/api." }, { status: 403 }),
  });
  await newChat();
  const dialog = screen.getByRole("dialog", { name: "New chat" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start the chat" }));
  expect(await within(dialog).findByText("You can't do this on acme/api.")).toBeTruthy();
});

test("the conversation: your messages and the agent's answers from the runs' logs, its tools folded", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const done = chatRun({ id: "run-1", status: "ok", finishedAt: 5_000 });
  const live = chatRun({ id: "run-2", mode: "continue", startedAt: 9_000 });
  show(makeChats([makeChat({ status: "idle", runs: [live, done] })]));
  await screen.findByRole("log", { name: "Conversation" });
  // One stream per run, oldest first.
  await waitFor(() => expect(FakeSource.opened.length).toBe(2));
  const [first, second] = FakeSource.opened;
  expect(first.url).toBe("api/runs/run-1/stream");
  first.emit("entries", [
    { kind: "phase", phase: "setup", at: 1_000 },
    { kind: "meta", text: "Starting a chat" },
    { kind: "message", text: "What does run() do?" },
    { kind: "phase", phase: "work", at: 2_000 },
    { kind: "tool", name: "Read", text: "src/run.mjs", id: "t1" },
    { kind: "output", text: "export function run() {}", error: false, id: "t1" },
    { kind: "text", text: "It starts a run." },
    { kind: "result", status: "ok", text: "It starts a run.", minutes: 1 },
  ] satisfies Entry[]);
  first.emit("end", {});
  second.emit("entries", [
    { kind: "phase", phase: "work", at: 9_000 },
    { kind: "message", text: "And follow()?" },
  ] satisfies Entry[]);
  const log = screen.getByRole("log", { name: "Conversation" });
  expect(await within(log).findByText("What does run() do?")).toBeTruthy();
  // The result repeats the answer: shown once.
  expect(within(log).getAllByText("It starts a run.").length).toBe(1);
  expect(within(log).getByText("1 tool call")).toBeTruthy();
  expect(within(log).getByText("And follow()?")).toBeTruthy();
  expect(within(log).getByText(/^Sandbox resumed/)).toBeTruthy();
  expect(screen.getByText("Its sandbox waits for your next message.")).toBeTruthy();
});

test("sending: Enter sends, Shift Enter doesn't; a message queued while the sandbox resumes stays shown", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const list = makeChats([makeChat()]);
  const api = show(list, {
    "POST api/chats/0123456789abcdef/messages": ({ body }) => {
      // Its sandbox starts again: the message waits in the queue.
      const chat = makeChat({
        status: "running",
        pending: [{ text: body.text, queuedAt: 1 }],
        runs: [chatRun({ phase: "setup" }), chatRun({ id: "run-0", status: "ok" })],
      });
      list.chats = [chat];
      return { chat };
    },
  });
  const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  fireEvent.input(box, { target: { value: "Run the tests" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(api.posted).toEqual([]);
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() =>
    expect(api.posted).toEqual([
      { url: "api/chats/0123456789abcdef/messages", body: { text: "Run the tests" } },
    ]),
  );
  expect(box.value).toBe("");
  const log = screen.getByRole("log", { name: "Conversation" });
  expect(await within(log).findByText("Run the tests")).toBeTruthy();
  expect(await within(log).findByText(/^Queued/)).toBeTruthy();
  expect(screen.getAllByText("Resuming").length).toBeGreaterThan(0);
});

test("a message refused: said, and put back in the box", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  show(makeChats([makeChat()]), {
    "POST api/chats/0123456789abcdef/messages": () =>
      Response.json({ error: "This chat is being reset or deleted." }, { status: 409 }),
  });
  const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  fireEvent.input(box, { target: { value: "Hello" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Not sent: This chat is being reset or deleted.")).toBeTruthy();
  expect(box.value).toBe("Hello");
});

test("a chat its owner can no longer reach: no composer, Delete still there", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  show(makeChats([makeChat({ reachable: false })]));
  const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  expect(box.disabled).toBe(true);
  expect(screen.getByText(/you can only delete this chat/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Chat menu" }));
  expect(screen.getByRole("menuitem", { name: "Delete…" })).toBeTruthy();
});

test("Reset: asked first, saying what is lost, then the chat as reset", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const api = show(makeChats([makeChat({ status: "idle" })]), {
    "POST api/chats/0123456789abcdef/reset": () => ({ chat: makeChat({ resetAt: 5 }) }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Chat menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Reset…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Reset this chat?" });
  expect(within(dialog).getByText(/clone of the repository and the agent's session/)).toBeTruthy();
  // Cancel sends nothing.
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(api.posted).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Chat menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Reset…" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset the chat" }));
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog", { name: "Reset this chat?" })).toBeNull(),
  );
  expect(api.posted).toEqual([{ url: "api/chats/0123456789abcdef/reset", body: undefined }]);
  expect(location.hash).toBe("#/chats/0123456789abcdef");
});

test("Delete: asked first, then back to the list without it", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const list = makeChats([makeChat()]);
  const api = show(list, {
    "DELETE api/chats/0123456789abcdef": () => {
      list.chats = [];
      return { message: "Chat deleted." };
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Chat menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete this chat?" });
  expect(within(dialog).getByText(/the whole conversation\. This can't be undone/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete the chat" }));
  await waitFor(() => expect(location.hash).toBe("#/chats"));
  expect(api.posted).toEqual([{ url: "api/chats/0123456789abcdef", body: undefined }]);
  expect(await screen.findByText("No chats yet.")).toBeTruthy();
});

test("chatState: starting, resuming, waiting for a slot, running, idle, stopped", () => {
  const at = (partial: Partial<Chat>) => chatState(makeChat(partial));
  expect(at({ status: "running", runs: [] })).toBe("starting");
  expect(at({ status: "running", runs: [chatRun({ phase: "setup" })] })).toBe("starting");
  expect(
    at({ status: "running", runs: [chatRun({ phase: "image" }), chatRun({ status: "ok" })] }),
  ).toBe("resuming");
  expect(at({ status: "running", queued: true })).toBe("waiting");
  expect(at({ status: "running", runs: [chatRun()] })).toBe("working");
  expect(at({ status: "idle" })).toBe("idle");
  expect(at({ status: "stopped" })).toBe("stopped");
});

test("runTurns: a failed run's reason, the sandbox's start folded apart", () => {
  const turns = runTurns(
    chatRun({ status: "error" }),
    [
      { kind: "phase", phase: "setup", at: 0 },
      { kind: "message", text: "Hi" },
      { kind: "raw", text: "Cloning into 'app'..." },
      { kind: "phase", phase: "work", at: 1_000 },
      { kind: "result", status: "error", text: "The agent's API refused the call.", minutes: 0 },
    ],
    2_000,
  );
  expect(turns.map((t) => t.kind)).toEqual(["you", "sandbox", "error"]);
});
