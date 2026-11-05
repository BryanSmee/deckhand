// Settings › MCP clients' machines against a fake api/machines: the list with the warning, its
// empty state, Remove, and a refused Remove.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Clients } from "./Clients";
import { Machines } from "./Machines";
import { mockApi } from "./testUtils";
import type { Machine } from "./types";

const NOW = 1_700_000_000_000;
const machine = (id: string, name: string, extra: Partial<Machine> = {}): Machine => ({
  id,
  name,
  labels: ["unreal", "gpu"],
  capacity: 1,
  repos: ["acme/game", "acme/*"],
  version: "0.1.0",
  createdAt: NOW - 86_400_000,
  seenAt: NOW - 20_000,
  online: true,
  ...extra,
});

const WARNING =
  /An agent runs on these machines on its own, with your files, credentials and network/;

test("lists your machines with the warning, and Remove removes one", async () => {
  let machines = [
    machine("a1", "desk"),
    machine("b2", "laptop", {
      labels: [],
      capacity: 2,
      online: false,
      version: null,
      seenAt: NOW - 7_200_000,
    }),
  ];
  const api = mockApi({
    "api/machines": () => ({ machines }),
    "POST api/machines/a1/remove": () => {
      machines = machines.filter((m) => m.id !== "a1");
      return { removed: "a1" };
    },
  });
  render(<Machines now={() => NOW} />);
  expect(await screen.findByText("desk")).toBeTruthy();
  expect(screen.getByText(WARNING)).toBeTruthy();
  expect(screen.getByText("Online")).toBeTruthy();
  expect(
    screen.getByText(/unreal, gpu · 1 run at once · last seen 20s ago · driver 0\.1\.0/),
  ).toBeTruthy();
  expect(screen.getAllByText("acme/game, acme/*")).toHaveLength(2);
  expect(screen.getByText("Offline")).toBeTruthy();
  expect(screen.getByText(/No labels · 2 runs at once · last seen 2 h ago$/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove desk" }));
  await waitFor(() => expect(screen.queryByText("desk")).toBeNull());
  expect(api.posted.map((p) => p.url)).toEqual(["api/machines/a1/remove"]);
  expect(screen.getByText("laptop")).toBeTruthy();
});

test("none registered: says so, the warning still shown", async () => {
  mockApi({ "api/machines": () => ({ machines: [] }) });
  render(<Machines now={() => NOW} />);
  expect(await screen.findByText(/No machine is registered/)).toBeTruthy();
  expect(screen.getByText(WARNING)).toBeTruthy();
});

test("a refused Remove shows why, and the machine stays", async () => {
  mockApi({
    "api/machines": () => ({ machines: [machine("a1", "desk")] }),
    "POST api/machines/a1/remove": () =>
      Response.json({ error: "No machine a1 of yours: register it again." }, { status: 404 }),
  });
  render(<Machines now={() => NOW} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove desk" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "No machine a1 of yours: register it again.",
  );
  expect(screen.getByText("desk")).toBeTruthy();
});

test("Settings › MCP clients shows your machines under the clients", async () => {
  mockApi({
    "api/mcp/clients": () => ({ resource: "https://deck.example.com/mcp", clients: [] }),
    "api/machines": () => ({ machines: [machine("a1", "desk")] }),
  });
  render(<Clients now={() => NOW} />);
  expect(await screen.findByRole("heading", { name: "Your machines" })).toBeTruthy();
  expect(await screen.findByText("desk")).toBeTruthy();
});
