// A machine task on its page (listener/claims.mjs): whose machines take it, its state in words,
// the comments held for its owner, whom alone Deliver and Drop are offered to, and its run's tool
// requests, which the owner alone answers.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { expect, test } from "vitest";
import { taskStatus } from "./format";
import { HeldComments, MachineFact, MachineSetup, ToolRequests } from "./MachineTask";
import { makeRuns, makeTask, mockApi } from "./testUtils";
import type { Run, TaskMachine, ToolRequest } from "./types";

const NOW = 1_700_000_000_000;
const route = (over: Partial<TaskMachine> = {}): TaskMachine => ({
  owner: "alice",
  want: "unreal",
  via: "label",
  machine: null,
  claimed: false,
  available: true,
  ...over,
});

test("a machine task says what it waits for, then where it works", () => {
  const waiting = makeTask({ state: "queued", machine: route() });
  expect(taskStatus(waiting).label).toBe("Waiting for unreal");
  render(<MachineFact task={waiting} />);
  expect(
    screen.getByText(
      "Runs on @alice's machines labelled unreal: waiting for one of them to claim it",
    ),
  ).toBeTruthy();
  const working = makeTask({
    state: "working",
    machine: route({ machine: "Desk", claimed: true }),
  });
  expect(taskStatus(working).label).toBe("On Desk");
  render(<MachineFact task={working} />);
  expect(screen.getByText("Claimed by @alice's Desk")).toBeTruthy();
  const away = makeTask({ state: "queued", machine: route({ via: "comment", available: false }) });
  render(<MachineFact task={away} />);
  expect(
    screen.getByText("Runs on @alice's machines (unreal): none of them is online"),
  ).toBeTruthy();
  // Any other task: its state's own name.
  expect(taskStatus(makeTask({ state: "queued" })).label).toBe("Queued");
});

test("held comments: listed for everyone who sees the task, delivered or dropped by its owner alone", async () => {
  const held = [
    { author: "bob", at: NOW - 60_000, text: "Also the menu.", url: "https://github.com/c/1" },
  ];
  const task = makeTask({ repo: "acme/game", number: 12, machine: route(), held });
  const api = mockApi({ "POST api/held/acme/game/12/deliver": () => ({ delivered: 1 }) });
  const { unmount } = render(<HeldComments task={task} user="bob" now={NOW} />);
  expect(screen.getByText("1 comment held for @alice")).toBeTruthy();
  expect(screen.getByText("Also the menu.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "@bob" }).getAttribute("href")).toBe(
    "https://github.com/c/1",
  );
  expect(screen.queryByRole("button", { name: "Deliver" })).toBeNull();
  unmount();
  let refreshed = 0;
  render(
    <HeldComments task={task} user="Alice" now={NOW} refresh={async () => void refreshed++} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Deliver" }));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(api.posted.map((p) => p.url)).toEqual(["api/held/acme/game/12/deliver"]);
  expect(screen.getByRole("button", { name: "Drop" })).toBeTruthy();
});

test("a machine run's tool request: its input as text, never markup; Allow and Deny for its owner alone", async () => {
  const request: ToolRequest = {
    id: "0123456789abcdef",
    tool: "Bash",
    input: "echo '<img src=x onerror=alert(1)> **bold**'",
    machine: "Desk",
    owner: "alice",
    state: "pending",
    message: null,
    at: NOW - 60_000,
    expiresAt: NOW + 9 * 60_000,
  };
  const task = makeTask({
    repo: "acme/game",
    number: 12,
    machine: route({ machine: "Desk", claimed: true }),
    permissions: [request],
  });
  const url = "api/permissions/acme/game/12/0123456789abcdef/run";
  const api = mockApi({ [`POST ${url}`]: () => ({ request: { ...request, state: "granted" } }) });
  const { container, unmount } = render(<ToolRequests task={task} user="bob" now={NOW} />);
  expect(screen.getByText("Desk asks to use")).toBeTruthy();
  expect(screen.getByText("Bash")).toBeTruthy();
  expect(screen.getByText("echo '<img src=x onerror=alert(1)> **bold**'")).toBeTruthy();
  expect(container.querySelector("img, strong")).toBeNull();
  expect(
    screen.getByText(/Only @alice answers.*Denied in 9 minutes without an answer\./),
  ).toBeTruthy();
  // Bob sees it, without the buttons.
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  unmount();
  let refreshed = 0;
  render(
    <ToolRequests task={task} user="Alice" now={NOW} refresh={async () => void refreshed++} />,
  );
  expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow for this run" }));
  await waitFor(() => expect(refreshed).toBe(1));
  expect(api.posted.map((p) => p.url)).toEqual([url]);
});

const makeRun = (over: Partial<Run>): Run => ({ ...makeRuns("acme/game#12", 1)[0], ...over });

test("how a machine's run runs, as it reports it (#599): what it said, never a sandbox run's", () => {
  const run = makeRun({
    machine: "Desk",
    setup: { version: "2.1.3", sandbox: false, permissionMode: "acceptEdits", suggested: true },
  });
  render(<MachineSetup run={run} />);
  const fact = screen.getByText(
    "As Desk reports it: v2.1.3 · sandbox off · acceptEdits mode · Deckhand's settings",
  );
  expect(fact.getAttribute("title")).toMatch(/Deckhand doesn't check it/);
  const { container } = render(<MachineSetup run={makeRun({ setup: null })} />);
  expect(container.textContent).toBe("");
});
