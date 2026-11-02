// The services' health: Settings › Server's diagram (a phone's list), each state's colour and
// words, the legend, the refresh, and the shell's alert.
import { render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import type { RepoList } from "./api";
import { Dashboard } from "./App";
import { HealthAlert, healthAlert, Services, stateText } from "./Health";
import { makeState, mockApi } from "./testUtils";
import type { Health, ServerSetup, ServiceHealth } from "./types";

const NOW = 1_791_990_000_000;
const MIN = 60_000;

const service = (s: Partial<ServiceHealth> & Pick<ServiceHealth, "name">): ServiceHealth => ({
  state: "up",
  startedAt: NOW - 3 * 24 * 60 * MIN,
  version: "1.4.0",
  checkedAt: NOW,
  ...s,
});

const HEALTH: Health = {
  checkedAt: NOW,
  services: [
    service({ name: "edge" }),
    service({ name: "orchestrator", startedAt: NOW - 3 * 60 * MIN }),
    service({ name: "runner", state: "starting", startedAt: NOW - 2 * MIN }),
    service({ name: "broker" }),
    service({ name: "github" }),
    service({
      name: "models",
      state: "down",
      startedAt: null,
      version: null,
      reason: "timeout",
    }),
    service({ name: "policy" }),
  ],
};

const SETUP: ServerSetup = {
  engine: null,
  proxy: { on: true, hosts: 3 },
  grants: { ok: true, file: null, message: null },
  allowedUsers: ["alice"],
  allowedRepos: [],
};

const list = (): RepoList => ({
  repos: [],
  app: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  listedAt: null,
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
});

const node = (name: string) => document.querySelector<SVGGElement>(`g[data-service="${name}"]`)!;

test("each state in words: up for how long, started when, unreachable and why", () => {
  expect(stateText(HEALTH.services[0])).toBe("up 3 d 0 h");
  expect(stateText(HEALTH.services[2])).toBe("started 2 min ago");
  expect(stateText(HEALTH.services[5])).toBe("unreachable: timeout");
  // A service that doesn't say when it started.
  expect(stateText(service({ name: "proxy", startedAt: null }))).toBe("up");
});

test("the diagram: each service in its state's colour and words, the outside parts grey", () => {
  render(<Services health={HEALTH} />);
  const colour = (name: string) => node(name).getAttribute("class");
  expect(colour("edge")).toContain("s-done");
  expect(colour("runner")).toContain("s-run");
  expect(colour("models")).toContain("s-err");
  expect(within(node("edge") as unknown as HTMLElement).getByText("up 3 d 0 h")).toBeTruthy();
  expect(
    within(node("runner") as unknown as HTMLElement).getByText("started 2 min ago"),
  ).toBeTruthy();
  expect(
    within(node("models") as unknown as HTMLElement).getByText("unreachable: timeout"),
  ).toBeTruthy();
  // The proxy has no URL here: grey, and said so.
  expect(colour("proxy")).toContain("s-idle");
  expect(within(node("proxy") as unknown as HTMLElement).getByText("not checked")).toBeTruthy();
  // GitHub, the agents' APIs, the granted hosts and the sandboxes: never checked.
  for (const label of ["GitHub", "agents' APIs", "granted hosts", "sandboxes"]) {
    const text = [...document.querySelectorAll("text")].find((t) => t.textContent === label);
    expect(text!.closest("g")!.getAttribute("class")).toContain("s-idle");
  }
  // Its states named for screen readers too, and the legend under it.
  expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
    /runner started 2 min ago.*models unreachable: timeout/,
  );
  const legend = within(screen.getByRole("list", { name: "Legend" }));
  for (const label of ["Up", "Starting", "Down", "Not checked"]) {
    expect(legend.getByText(label)).toBeTruthy();
  }
  expect(screen.getByText(/^Checked at .* · every 15 s$/)).toBeTruthy();
});

test("a phone's list: a row per service, in the same colours, no diagram", () => {
  render(<Services health={HEALTH} narrow />);
  expect(screen.queryByRole("img")).toBeNull();
  const row = (name: string) => document.querySelector<HTMLElement>(`li[data-service="${name}"]`)!;
  expect(row("edge").className).toContain("s-done");
  expect(row("runner").className).toContain("s-run");
  expect(row("models").className).toContain("s-err");
  expect(within(row("models")).getByText("unreachable: timeout")).toBeTruthy();
  expect(within(row("runner")).getByText("sandboxes, images, logs")).toBeTruthy();
  expect(document.querySelectorAll("li[data-service]")).toHaveLength(7);
});

test("the services' warnings: one row each, under its name; none, no list", () => {
  const warned: Health = {
    ...HEALTH,
    services: HEALTH.services.map((s) =>
      s.name === "runner"
        ? { ...s, warnings: ["The runs' logs take Redis's memory: set BLOB_URL"] }
        : s,
    ),
  };
  const { rerender } = render(<Services health={warned} />);
  const list = screen.getByRole("list", { name: "Warnings" });
  const row = list.querySelector<HTMLElement>('li[data-service="runner"]')!;
  expect(row.textContent).toBe("runner The runs' logs take Redis's memory: set BLOB_URL");
  expect(list.querySelectorAll("li")).toHaveLength(1);
  rerender(<Services health={warned} narrow />);
  expect(screen.getByRole("list", { name: "Warnings" })).toBeTruthy();
  rerender(<Services health={HEALTH} />);
  expect(screen.queryByRole("list", { name: "Warnings" })).toBeNull();
});

test("before the first answer, or when it can't be read", () => {
  const { rerender } = render(<Services health={null} />);
  expect(screen.getByText("Checking…")).toBeTruthy();
  rerender(<Services health={null} error="HTTP 502" />);
  expect(screen.getByText("Couldn't check them (HTTP 502)")).toBeTruthy();
});

test("the alert: red for a service down, blue for one starting, nothing when all are up", () => {
  expect(healthAlert(HEALTH)).toEqual({ tone: "err", text: "models down" });
  const starting = { ...HEALTH, services: HEALTH.services.filter((s) => s.state !== "down") };
  expect(healthAlert(starting)).toEqual({ tone: "run", text: "runner starting" });
  const up = { ...HEALTH, services: HEALTH.services.filter((s) => s.state === "up") };
  expect(healthAlert(up)).toBeNull();
  const many = {
    ...HEALTH,
    services: HEALTH.services.map((s) => ({ ...s, state: "down" as const })),
  };
  expect(healthAlert(many)?.text).toBe("7 services down");

  const { rerender } = render(<HealthAlert health={HEALTH} />);
  const link = screen.getByRole("link", { name: "Models down: see the services' status" });
  expect(link.getAttribute("href")).toBe("#/settings/server");
  expect(link.querySelector(".s-err")).toBeTruthy();
  rerender(<HealthAlert health={starting} />);
  expect(screen.getByRole("link").querySelector(".s-run")).toBeTruthy();
  rerender(<HealthAlert health={up} />);
  expect(screen.queryByRole("link")).toBeNull();
});

let reads: ReturnType<typeof vi.fn<() => Health>>;
beforeEach(() => {
  reads = vi.fn<() => Health>(() => HEALTH);
  mockApi({ "api/health": reads, "api/server": () => SETUP });
});

test("the shell reads it every minute, and every 15 s while the status page is open", async () => {
  vi.useFakeTimers();
  try {
    render(<Dashboard state={makeState()} error={null} repos={list()} />);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(1);
    // The sidebar's alert: models is down.
    expect(screen.getByRole("link", { name: /^Models down/ })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toHaveBeenCalledTimes(2);

    // Opening Settings › Server reads it at once, then every 15 s.
    location.hash = "#/settings/server";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(node("models").getAttribute("class")).toContain("s-err");
    reads.mockImplementation(() => ({
      ...HEALTH,
      services: HEALTH.services.map((s) =>
        s.name === "models"
          ? service({ name: "models", state: "starting", startedAt: NOW - 30_000 })
          : s,
      ),
    }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reads).toHaveBeenCalledTimes(4);
    // Back: models is starting now, and the alert says so.
    expect(node("models").getAttribute("class")).toContain("s-run");
    expect(screen.getByRole("link", { name: /^Runner and models starting/ })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
