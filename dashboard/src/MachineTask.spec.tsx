// A machine task on its page (listener/claims.mjs): whose machines take it, its state in words,
// and the comments held for its owner, whom alone Deliver and Drop are offered to.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { expect, test } from "vitest";
import { taskStatus } from "./format";
import { HeldComments, MachineFact } from "./MachineTask";
import { makeTask, mockApi } from "./testUtils";
import type { TaskMachine } from "./types";

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
