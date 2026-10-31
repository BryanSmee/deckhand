// A repository's Capabilities tab against a fake api/repos/<repo>/config: each mode's
// capabilities and the files that decided them, a mode whose runs wouldn't start (the tab's
// count and the header's badge say so), a repo's own mode with a warning, the catalogue, and
// policies that can't be evaluated.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { ConfigPanel } from "./ConfigPanel";
import { makeCapabilities, makeModeCapabilities, mockApi } from "./testUtils";
import type { Capabilities, RepoConfig } from "./types";

const CONFIG: RepoConfig = {
  repo: {
    repo: "acme/app",
    url: "https://github.com/acme/app",
    private: true,
    issues: true,
    status: "configured",
    issue: null,
    readAt: Date.now(),
    autoMerge: false,
  },
  base: "main",
  file: null,
  errors: [],
  warnings: [],
  grantsError: null,
  effective: { settings: [], hosts: [], mounts: [], grant: null },
  policies: { files: [], errors: [], warnings: [] },
  capabilities: makeCapabilities(),
  readAt: Date.now(),
};

let capabilities: Capabilities;
beforeEach(() => {
  capabilities = makeCapabilities();
  mockApi({
    "api/repos/acme/app/config": () => ({ ...CONFIG, capabilities, readAt: Date.now() }),
  });
});

const panel = () =>
  render(
    <ConfigPanel
      repo="acme/app"
      tab="capabilities"
      row={null}
      onRow={() => {}}
      onBack={() => {}}
      now={Date.now()}
    />,
  );
const mode = (name: string) => screen.getByRole("listitem", { name: `The ${name} mode` });

test("each mode's capabilities, the file that decided them, and every capability folded", async () => {
  panel();
  const work = await screen.findByRole("listitem", { name: "The work mode" });
  const chips = within(work).getByLabelText("Its capabilities");
  expect([...chips.children].map((c) => c.textContent)).toEqual([
    "pull",
    "push",
    "setup",
    "read:issues",
  ]);
  expect(within(work).getByText("Starts")).toBeTruthy();
  expect(within(work).getByText("Decided by mode-work.rego")).toBeTruthy();
  // Every capability, with why it isn't used.
  fireEvent.click(within(work).getByText("Every capability"));
  const docker = within(work).getByText("docker", { selector: "li > span" }).closest("li")!;
  expect(docker.textContent).toContain("Not allowed");
  expect(docker.textContent).toContain("no allow rule of the operator's policies gives it");
  // No count on the tab, no badge: every mode's runs start.
  const tab = screen.getByRole("link", { name: "Capabilities" });
  expect(tab.getAttribute("aria-current")).toBe("page");
  expect(tab.textContent).toBe("Capabilities");
  // The catalogue: what asks for each, the grant that gates it.
  const catalogue = screen.getByRole("list", { name: "The catalogue" });
  const image = within(catalogue).getByText("image:repo").closest("li")!;
  expect(image.textContent).toContain("dockerfile · grant dockerfile");
  const pull = within(catalogue)
    .getByText("pull", { selector: "li > span:first-child" })
    .closest("li")!;
  expect(pull.textContent).toContain("the policies alone");
});

test("modes whose runs wouldn't start, and a repo's own mode with a warning", async () => {
  capabilities = makeCapabilities({
    modes: [
      makeModeCapabilities(
        {
          mode: "work",
          errors: ["setup needs pull, which the run doesn't get"],
        },
        ["setup"],
      ),
      // As outcomeOf() says it: a repo's own mode its policies give nothing doesn't start.
      makeModeCapabilities({
        mode: "audit",
        custom: true,
        errors: [
          "no allow_capabilities rule of the repository's policies (.deckhand/policy/) gives this mode anything: add one naming what its runs get (pull, push, setup…)",
        ],
      }),
      // One its policies give no push: it starts without what needs it.
      makeModeCapabilities(
        {
          mode: "notes",
          custom: true,
          warnings: [
            "image:branch isn't used: it needs push: no allow rule of the repository's policies gives it",
          ],
        },
        ["pull", "read:issues"],
      ),
    ],
  });
  panel();
  const work = await screen.findByRole("listitem", { name: "The work mode" });
  expect(within(work).getByText("Doesn't start")).toBeTruthy();
  expect(within(work).getByRole("list", { name: "What stops its runs" }).textContent).toBe(
    "setup needs pull, which the run doesn't get",
  );
  // The tab's count and the header's badge.
  expect(screen.getByRole("link", { name: "Capabilities 2" })).toBeTruthy();
  expect(screen.getByText("2 modes can't run")).toBeTruthy();
  const audit = mode("audit");
  expect(within(audit).getByText("repo's own")).toBeTruthy();
  expect(within(audit).getByText("Doesn't start")).toBeTruthy();
  expect(within(audit).getByText("Nothing of the repository's")).toBeTruthy();
  expect(within(audit).getByRole("list", { name: "What stops its runs" }).textContent).toMatch(
    /gives this mode anything/,
  );
  const notes = mode("notes");
  expect(within(notes).getByText("Starts, with warnings")).toBeTruthy();
  expect(within(notes).getByRole("list", { name: "Warnings" }).textContent).toMatch(
    /isn't used: it needs push/,
  );
});

test("policies that can't be evaluated: no run starts, no mode listed", async () => {
  capabilities = makeCapabilities({
    modes: [],
    error: "policy error: a.rego:3: var x is unsafe",
  });
  panel();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The policies can't decide what runs get: no run starts");
  expect(alert.textContent).toContain("policy error: a.rego:3: var x is unsafe");
  expect(screen.queryByRole("listitem", { name: "The work mode" })).toBeNull();
  expect(screen.getByText("Capabilities: policy error")).toBeTruthy();
  // The catalogue still shows.
  expect(screen.getByRole("list", { name: "The catalogue" })).toBeTruthy();
});
