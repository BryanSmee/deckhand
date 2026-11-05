// The Chats page (#477): the list and its limit, New chat, the conversation from its runs' logs,
// sending (Enter, Shift Enter), messages queued while the sandbox resumes, Reset and Delete
// (fetch and the log streams mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { chatNote, chatState, HOLD_MS, holdMessages, runTurns } from "./chatModel";
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
  const { unmount } = render(<Dashboard state={state} error={null} />);
  return Object.assign(api, { unmount });
}

test("the list: the chats with how many the user keeps, Chats among the views, a chat opened", async () => {
  show(makeChats([makeChat(), makeChat({ id: "fedcba9876543210", title: "Try the build" })]));
  const views = await screen.findByRole("group", { name: "View" });
  const nav = await within(views).findByRole("link", { name: /Chats\s*2 of 4/ });
  expect(nav.getAttribute("aria-current")).toBe("page");
  const list = screen.getByRole("complementary", { name: "Your chats" });
  expect(within(list).getByRole("heading", { name: /Your chats\s*2 of 4/ })).toBeTruthy();
  fireEvent.click(within(list).getByRole("link", { name: /Try the build/ }));
  await waitFor(() => expect(location.hash).toBe("#/chats/fedcba9876543210"));
  const chat = await screen.findByRole("region", { name: "Try the build" });
  expect(within(chat).getByText("acme/app")).toBeTruthy();
  expect(within(chat).getByText("Stopped")).toBeTruthy();
  // Opened from All's list, as a task from All's tasks: the header stays All's.
  expect(screen.getByRole("heading", { name: "All repositories", level: 1 })).toBeTruthy();
});

test("the header: All's on every repository's chats, no GitHub link", async () => {
  show(makeChats([makeChat(), makeChat({ id: "fedcba9876543210", repo: "acme/api" })]));
  const views = await screen.findByRole("group", { name: "View" });
  await within(views).findByRole("link", { name: /Chats/ });
  expect(screen.getByRole("heading", { name: "All repositories", level: 1 })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /on GitHub$/ })).toBeNull();
  expect(within(views).getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("#/tasks");
  // Every repository's chats, each with its repository.
  const list = screen.getByRole("complementary", { name: "Your chats" });
  expect(within(list).getAllByRole("link")).toHaveLength(2);
  expect(within(list).getByText(/^acme\/api · /)).toBeTruthy();
});

test("a repository's chats: its name and GitHub link, its views, only its chats", async () => {
  history.replaceState(null, "", "#/acme/app/chats");
  show(
    makeChats([
      makeChat(),
      makeChat({ id: "fedcba9876543210", repo: "acme/api", title: "Elsewhere" }),
    ]),
  );
  const views = await screen.findByRole("group", { name: "View" });
  const nav = await within(views).findByRole("link", { name: /Chats\s*2 of 4/ });
  expect(nav.getAttribute("aria-current")).toBe("page");
  expect(nav.getAttribute("href")).toBe("#/acme/app/chats");
  expect(screen.getByRole("heading", { name: "acme/app", level: 1 })).toBeTruthy();
  const github = screen.getByRole("link", { name: "acme/app on GitHub" });
  expect(github.getAttribute("href")).toBe("https://github.example.com/acme/app");
  expect(within(views).getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe(
    "#/acme/app",
  );
  expect(within(views).getByRole("link", { name: "Board" }).getAttribute("href")).toBe(
    "#/acme/app/board",
  );
  // The sidebar marks the repository, its links staying on Chats.
  const repos = screen.getByRole("navigation", { name: "Repositories" });
  const app = within(repos).getByRole("link", { name: /acme\/app/ });
  expect(app.getAttribute("aria-current")).toBe("page");
  expect(
    within(repos)
      .getByRole("link", { name: /acme\/api/ })
      .getAttribute("href"),
  ).toBe("#/acme/api/chats");
  expect(
    within(repos)
      .getByRole("link", { name: /All repositories/ })
      .getAttribute("href"),
  ).toBe("#/chats");
  // Its chats alone, opened on its page.
  const list = screen.getByRole("complementary", { name: "Your chats" });
  expect(within(list).queryByRole("link", { name: /Elsewhere/ })).toBeNull();
  fireEvent.click(within(list).getByRole("link", { name: /What does run\(\) do\?/ }));
  await waitFor(() => expect(location.hash).toBe("#/acme/app/chats/0123456789abcdef"));
  expect(await screen.findByRole("region", { name: "What does run() do?" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "acme/app", level: 1 })).toBeTruthy();
});

test("Chats from a repository's tasks: that repository's; Tasks and g t go back to it", async () => {
  history.replaceState(null, "", "#/acme/api");
  show(makeChats([makeChat()]));
  const press = (key: string) => fireEvent.keyDown(document.body, { key });
  const views = await screen.findByRole("group", { name: "View" });
  fireEvent.click(await within(views).findByRole("link", { name: /Chats/ }));
  await waitFor(() => expect(location.hash).toBe("#/acme/api/chats"));
  await screen.findByRole("heading", { name: "acme/api", level: 1 });
  expect(await screen.findByText("No chats on acme/api yet.")).toBeTruthy();
  const tasks = within(screen.getByRole("group", { name: "View" })).getByRole("link", {
    name: "Tasks",
  });
  expect(tasks.getAttribute("href")).toBe("#/acme/api");
  press("g");
  press("t");
  await waitFor(() => expect(location.hash).toMatch(/^#\/acme\/api(\?|$)/));
});

test("New chat on a repository's page: that repository first; one on another opens on its page", async () => {
  history.replaceState(null, "", "#/acme/app/chats");
  const list = makeChats();
  const made = makeChat({ id: "aaaaaaaaaaaaaaaa", repo: "acme/api", title: "Hi" });
  show(list, {
    "POST api/chats": () => {
      list.chats = [made];
      return { chat: made };
    },
  });
  await newChat();
  const dialog = screen.getByRole("dialog", { name: "New chat" });
  const repo = within(dialog).getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
  expect(repo.value).toBe("acme/app");
  fireEvent.change(repo, { target: { value: "acme/api" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start the chat" }));
  await waitFor(() => expect(location.hash).toBe("#/acme/api/chats/aaaaaaaaaaaaaaaa"));
  expect(await screen.findByRole("heading", { name: "Hi", level: 2 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "acme/api", level: 1 })).toBeTruthy();
});

test("another repository's chat under a repository's chats: opened on its own repository's", async () => {
  history.replaceState(null, "", "#/acme/app/chats/fedcba9876543210");
  show(makeChats([makeChat({ id: "fedcba9876543210", repo: "acme/api", title: "Elsewhere" })]));
  await waitFor(() => expect(location.hash).toBe("#/acme/api/chats/fedcba9876543210"));
  expect(await screen.findByRole("region", { name: "Elsewhere" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "acme/api", level: 1 })).toBeTruthy();
});

test("the same, followed from Chats under a repository spelled otherwise: its own repository's all the same", async () => {
  show(makeChats([makeChat({ id: "fedcba9876543210", repo: "acme/api", title: "Elsewhere" })]));
  const list = await screen.findByRole("complementary", { name: "Your chats" });
  await within(list).findByRole("link", { name: /Elsewhere/ });
  // The sidebar spells it acme/app: its rewrite mustn't win over the chat's repository.
  history.replaceState(null, "", "#/Acme/App/chats/fedcba9876543210");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => expect(location.hash).toBe("#/acme/api/chats/fedcba9876543210"));
  expect(await screen.findByRole("region", { name: "Elsewhere" })).toBeTruthy();
  expect(screen.queryByText(/^No such chat/)).toBeNull();
});

test("a chat that isn't there, under a repository's chats: no such chat on it", async () => {
  history.replaceState(null, "", "#/acme/app/chats/fedcba9876543210");
  show(makeChats([makeChat()]));
  expect(
    await screen.findByText("No such chat on acme/app: it was deleted, or it isn't yours."),
  ).toBeTruthy();
  expect(location.hash).toBe("#/acme/app/chats/fedcba9876543210");
});

test("the repository shown on Chats is the one the dashboard reopens on", async () => {
  history.replaceState(null, "", "#/acme/app/chats");
  const first = show(makeChats([makeChat()]));
  await screen.findByRole("heading", { name: "acme/app", level: 1 });
  expect(localStorage.getItem("deckhand.tab")).toBe("acme/app");
  first.unmount();
  // Open on: the last repository (Preferences' default), from an empty address.
  history.replaceState(null, "", "#");
  const again = show(makeChats([makeChat()]));
  await waitFor(() => expect(location.hash).toMatch(/^#\/acme\/app(\?|$)/));
  again.unmount();
  // Every repository's chats: All, reopened on the Overview.
  history.replaceState(null, "", "#/chats");
  show(makeChats([makeChat()]));
  await screen.findByRole("heading", { name: "All repositories", level: 1 });
  expect(localStorage.getItem("deckhand.tab")).toBe("");
});

test("a phone: the top bar names the repository, its Chats tab stays on it; All's on All's tasks", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  history.replaceState(null, "", "#/acme/app/chats");
  show(makeChats([makeChat()]));
  expect(await screen.findByRole("button", { name: "acme/app: switch repository" })).toBeTruthy();
  const tabs = within(screen.getByRole("navigation", { name: "Pages" }));
  const chats = await tabs.findByRole("link", { name: "Chats" });
  expect(chats.getAttribute("href")).toBe("#/acme/app/chats");
  expect(chats.getAttribute("aria-current")).toBe("page");
  // From All's tasks, as their Tasks tab: every repository's chats, not the last one's.
  history.replaceState(null, "", "#/tasks");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() =>
    expect(tabs.getByRole("link", { name: "Chats" }).getAttribute("href")).toBe("#/chats"),
  );
});

test("a phone's tab bar: Tasks and Board the chats' repository, not the last one browsed; none with a chat open", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  history.replaceState(null, "", "#/acme/api");
  show(makeChats([makeChat()]));
  await screen.findByRole("button", { name: "acme/api: switch repository" });
  // acme/app's chats after acme/api's tasks (#871): Tasks and Board the top bar's repository.
  history.replaceState(null, "", "#/acme/app/chats");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("button", { name: "acme/app: switch repository" });
  const tabs = within(screen.getByRole("navigation", { name: "Pages" }));
  expect(tabs.getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("#/acme/app");
  expect(tabs.getByRole("link", { name: "Board" }).getAttribute("href")).toBe("#/acme/app/board");
  // A chat open: no tab bar, the conversation takes the screen.
  history.replaceState(null, "", "#/acme/app/chats/0123456789abcdef");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("region", { name: "What does run() do?" });
  expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
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

test("the agent's answers render as Markdown; your messages stay as typed", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  show(
    makeChats([makeChat({ status: "idle", runs: [chatRun({ status: "ok", finishedAt: 5_000 })] })]),
  );
  await waitFor(() => expect(FakeSource.opened.length).toBe(1));
  FakeSource.opened[0].emit("entries", [
    { kind: "phase", phase: "work", at: 1_000 },
    { kind: "message", text: "Is **this** bold?" },
    { kind: "text", text: "It **is**:\n\n```js\nrun();\n```" },
  ] satisfies Entry[]);
  const log = screen.getByRole("log", { name: "Conversation" });
  expect(await within(log).findByText("Is **this** bold?")).toBeTruthy();
  expect(within(log).getByText("is").tagName).toBe("STRONG");
  expect(within(log).getByText("run();").closest("pre")).toBeTruthy();
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

test("holdMessages: held after leaving pending, until a later logged message has it, or HOLD_MS", () => {
  const logged = [{ id: "r1:0", text: "yes" }];
  // Seen waiting: held, with the logged messages there were then.
  let { held, shown } = holdMessages([], { now: 0, pending: ["yes"], logged });
  expect(held).toEqual([{ text: "yes", seen: 0, before: ["r1:0"] }]);
  expect(shown).toEqual([]);
  // Out of `pending` (taken by a run whose log hasn't come): still shown, though an earlier
  // message said the same.
  ({ held, shown } = holdMessages(held, { now: 1_000, pending: [], logged }));
  expect(shown).toEqual(["yes"]);
  // A later logged message has it (a delivery joins the messages it takes): no longer held.
  const later = [...logged, { id: "r2:0", text: "no\n\n---\n\nyes" }];
  expect(holdMessages(held, { now: 2_000, pending: [], logged: later })).toEqual({
    held: [],
    shown: [],
  });
  // None comes: dropped after HOLD_MS.
  expect(holdMessages(held, { now: HOLD_MS, pending: [], logged }).shown).toEqual(["yes"]);
  expect(holdMessages(held, { now: HOLD_MS + 1, pending: [], logged }).shown).toEqual([]);
});

test("holdMessages: the same text twice is two messages; one sent is held from then", () => {
  let { held, shown } = holdMessages([], { now: 0, pending: ["ok", "ok"], logged: [] });
  expect(held.length).toBe(2);
  // One delivered, its log not here yet: both shown, one of them out of `pending`.
  ({ held, shown } = holdMessages(held, { now: 1, pending: ["ok"], logged: [] }));
  expect(shown).toEqual(["ok"]);
  ({ held, shown } = holdMessages(held, { now: 2, pending: [], sent: ["go"], logged: [] }));
  expect(shown).toEqual(["ok", "ok", "go"]);
});

test("a message delivered to the sandbox: shown once, as sent until its run's log has it", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const run = chatRun({ id: "run-1" });
  const chat = makeChat({ status: "idle", runs: [run] });
  let streamFirst = true;
  show(makeChats([chat]), {
    // Delivered at once: the answer lists it nowhere. The first one's log line streams in
    // before the answer comes.
    "POST api/chats/0123456789abcdef/messages": ({ body }) => {
      if (streamFirst) FakeSource.last!.emit("entries", [{ kind: "message", text: body.text }]);
      return { chat: { ...chat, status: "running" } };
    },
  });
  const box = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(FakeSource.last?.url).toBe("api/runs/run-1/stream"));
  const log = screen.getByRole("log", { name: "Conversation" });
  fireEvent.input(box, { target: { value: "Run the tests" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(within(log).queryByText("Sending…")).toBeNull());
  expect(within(log).getAllByText("Run the tests").length).toBe(1);
  expect(within(log).queryByText("Sent")).toBeNull();
  // The next one's log line comes after the answer: shown as sent meanwhile, then once.
  streamFirst = false;
  fireEvent.input(box, { target: { value: "And the lint" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await within(log).findByText("Sent")).toBeTruthy();
  expect(within(log).queryByText(/^Queued/)).toBeNull();
  FakeSource.last!.emit("entries", [{ kind: "message", text: "And the lint" }]);
  await waitFor(() => expect(within(log).queryByText("Sent")).toBeNull());
  expect(within(log).getAllByText("And the lint").length).toBe(1);
});

test("after a reset: starting afresh, not resuming, and the reset marked in the conversation", async () => {
  const old = chatRun({ id: "run-1", status: "ok", startedAt: 1_000, finishedAt: 2_000 });
  const reset = makeChat({ status: "stopped", resetAt: 5_000, runs: [old] });
  expect(chatNote(reset)).toMatch(/from a fresh clone/);
  expect(chatState({ ...reset, status: "running", runs: [old] })).toBe("starting");
  const fresh = chatRun({ id: "run-2", phase: "setup", startedAt: 6_000 });
  expect(chatState({ ...reset, status: "running", runs: [fresh, old] })).toBe("starting");
  expect(chatNote(makeChat({ runs: [old] }))).toMatch(/where the chat left off/);
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  show(makeChats([{ ...reset, status: "running", runs: [fresh, old] }]));
  const log = await screen.findByRole("log", { name: "Conversation" });
  const lines = within(log)
    .getAllByText(/^(Sandbox started|Chat reset)/)
    .map((p) => p.textContent!.split(" ")[1]);
  expect(lines).toEqual(["started", "reset", "started"]);
});

test("a long chat: its last runs' logs streamed, the earlier ones on demand", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const runs = Array.from({ length: 7 }, (_, i) =>
    chatRun({ id: `run-${7 - i}`, status: "ok", startedAt: (7 - i) * 1_000 }),
  );
  show(makeChats([makeChat({ runs })]));
  const more = await screen.findByRole("button", { name: "Show earlier (2 more sandbox runs)" });
  await waitFor(() => expect(FakeSource.opened.length).toBe(5));
  expect(FakeSource.opened[0].url).toBe("api/runs/run-3/stream");
  fireEvent.click(more);
  await waitFor(() => expect(FakeSource.opened.length).toBe(7));
  expect(screen.queryByRole("button", { name: /Show earlier/ })).toBeNull();
});

test("a reset before the runs shown: marked above them, the earlier runs not loaded", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const runs = Array.from({ length: 7 }, (_, i) =>
    chatRun({ id: `run-${7 - i}`, status: "ok", startedAt: (7 - i) * 1_000 }),
  );
  // Reset after run 2, which isn't shown.
  show(makeChats([makeChat({ runs, resetAt: 2_500 })]));
  const log = await screen.findByRole("log", { name: "Conversation" });
  expect(await screen.findByRole("button", { name: /Show earlier/ })).toBeTruthy();
  const lines = within(log)
    .getAllByText(/^(Sandbox started|Chat reset)/)
    .map((p) => p.textContent!.split(" ")[1]);
  expect(lines).toEqual(["reset", "started", "started", "started", "started", "started"]);
});

test("a user who may start no chat but keeps some: the Chats link all the same", async () => {
  history.replaceState(null, "", "#/");
  const repo = { actions: ["tasks:read"], starts: ["work"], startsDenied: [] };
  mockApi({ "api/chats": () => makeChats([makeChat({ reachable: false })]) });
  render(
    <Dashboard
      state={makeState({ access: { server: [], repos: { "acme/app": repo } } })}
      error={null}
    />,
  );
  expect(await screen.findByRole("link", { name: /Chats\s*1 of 4/ })).toBeTruthy();
});

test("Permissions: the chat's menu opens its permissions panel (#478)", async () => {
  history.replaceState(null, "", "#/chats/0123456789abcdef");
  const asked: string[] = [];
  show(makeChats([makeChat()]), {
    "api/chats/0123456789abcdef/permissions": ({ url }) => {
      asked.push(url);
      return {
        profile: { github: "read", capabilities: null, hosts: null, mounts: null },
        ceiling: { capabilities: [], hosts: ["pypi.org"], mounts: [], github: [] },
        effective: { github: "read", capabilities: ["pull"], hosts: ["pypi.org"], mounts: [] },
        errors: [],
        running: false,
      };
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Chat menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Permissions…" }));
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("pypi.org")).toBeTruthy();
  expect(asked).toEqual(["api/chats/0123456789abcdef/permissions"]);
});
