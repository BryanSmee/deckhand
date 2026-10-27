// A repository's config panel against a fake api/repos/<repo>/config: a config with errors
// (each with its key, fix and line, the file's bad lines marked), and a fine one (its banner,
// the facts at a glance, the details folded but for what the repo sets).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { ConfigPanel } from "./ConfigPanel";
import { mockApi } from "./testUtils";
import type { Repo, RepoConfig, SettingRow } from "./types";

const REPO: Repo = {
  repo: "acme/site",
  url: "https://github.com/acme/site",
  private: true,
  issues: true,
  status: "invalid",
  issue: null,
  readAt: Date.now(),
  autoMerge: false,
};

const TEXT = `# acme/site
users: [alice, bob]
max_parallel: 1
model: opus
effort: high
dockerfile: .deckhand/Dockerfile
modes:
  review: { agent: codex }
`;

const row = (key: string, value: string, extra: Partial<SettingRow> = {}): SettingRow => ({
  key,
  value,
  source: "operator",
  note: null,
  line: null,
  ...extra,
});

const SETTINGS: SettingRow[] = [
  row("users", "alice, bob", { source: "repo", note: "narrowed from ALLOWED_USERS", line: 2 }),
  row("trigger", "deckhand"),
  row("model", "opus", { source: "repo", line: 4 }),
  row("effort", "high", { source: "repo", line: 5 }),
  row("max_parallel", "1", { source: "repo", note: "MAX_PARALLEL is 2", line: 3 }),
  row("dockerfile", ".deckhand/Dockerfile", {
    source: "refused",
    note: "the operator's grants don't set allow_dockerfile: true for this repository",
    line: 6,
  }),
  row("limits", "2 CPUs, 4g memory, 2048 processes", { note: "built in" }),
];

const BROKEN: RepoConfig = {
  repo: REPO,
  base: "main",
  file: {
    text: TEXT,
    sha: "c03e7a1f00",
    url: "https://github.com/acme/site/blob/main/.deckhand.yaml",
    editUrl: "https://github.com/acme/site/edit/main/.deckhand.yaml",
  },
  errors: [
    {
      key: "modes.review",
      message: "review is built in: remove it and turn it on with a top-level review: block",
      line: 8,
      fix: "Remove modes.review and add review: true at the top level.",
    },
    { key: null, message: "something the check can't place", line: null, fix: null },
  ],
  warnings: [{ key: "colour", message: "unknown, ignored", line: null, fix: null }],
  grantsError: null,
  effective: {
    settings: SETTINGS,
    hosts: [
      { host: "github.com", source: "operator", note: "always" },
      { host: "registry.npmjs.org", source: "operator", note: "grants/default.yaml" },
    ],
    mounts: [],
    grant: {
      files: ["default.yaml"],
      allowPreview: false,
      allowDockerfile: false,
      allowBranchDockerImages: false,
      allowDocker: false,
      allowResearch: true,
      allowWorkflows: false,
      allowAutoMerge: false,
      acknowledgeAutoMergePreview: false,
      hosts: ["registry.npmjs.org"],
      cachedHosts: [],
      mounts: [],
      limits: { cpus: "2", memory: "4g", pids: 2048 },
    },
  },
  policies: { files: [], errors: [], warnings: [] },
  readAt: Date.now(),
};

const FINE: RepoConfig = {
  ...BROKEN,
  repo: { ...REPO, status: "configured" },
  file: { ...BROKEN.file!, text: TEXT.replace(/dockerfile.*\n|modes:\n.*\n/g, "") },
  errors: [],
  warnings: [],
  effective: {
    ...BROKEN.effective,
    settings: SETTINGS.filter((s) => s.key !== "dockerfile"),
    mounts: [
      {
        path: "/fixtures",
        source: "repo",
        readOnly: true,
        note: "under the granted root /srv/fixtures",
        line: null,
      },
    ],
  },
};

let config: RepoConfig;
const scrolled = vi.fn();
beforeEach(() => {
  config = BROKEN;
  mockApi({ "api/repos/acme/site/config": () => ({ ...config, readAt: Date.now() }) });
  scrolled.mockClear();
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this.id);
  };
});

const panel = () =>
  render(
    <ConfigPanel repo="acme/site" row={null} onRow={() => {}} onBack={() => {}} now={Date.now()} />,
  );

const fold = (name: RegExp) =>
  screen.getByText(name, { selector: "summary h2, summary h2 *" }).closest("details")!;

test("an invalid config: each error with its key, its fix and its line, when known", async () => {
  panel();
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByRole("heading").textContent).toBe(
    "No run starts until these are fixed",
  );
  const items = within(alert).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(items[0].textContent).toBe(
    "modes.review: review is built in: remove it and turn it on with a top-level review: blockline 8" +
      "Remove modes.review and add review: true at the top level.",
  );
  // The listener's fix, under its message.
  expect(within(items[0]).getByText(/^Remove modes\.review/).className).toMatch(/fix/);
  expect(items[1].textContent).toBe("something the check can't place");
  expect(items[2].textContent).toContain(
    "dockerfile: refused: the operator's grants don't set allow_dockerfile",
  );
  // Without a line, no link.
  expect(within(items[1]).queryByRole("button")).toBeNull();
  // What isn't granted says who grants it.
  expect(items[2].textContent).toContain("Only the operator grants it, in grants/acme/site.yaml");
  expect(within(items[2]).getByRole("button", { name: "line 6" })).toBeTruthy();
  expect(screen.getByLabelText("Warnings").textContent).toContain("colour: unknown, ignored");
  // The header: where it was read, and where to change it.
  expect(screen.getByText(/blob/).textContent).toMatch(
    /\.deckhand\.yaml on main · blob c03e7a1 · read/,
  );
  expect(screen.getByRole("link", { name: "Edit on GitHub" }).getAttribute("href")).toBe(
    "https://github.com/acme/site/edit/main/.deckhand.yaml",
  );
  expect(screen.queryByText(/Everything is fine/)).toBeNull();
});

test("the file: line numbers, its bad lines marked with their message, a line link goes there", async () => {
  panel();
  await screen.findByRole("alert");
  const yaml = fold(/\.deckhand\.yaml/);
  expect(yaml.open).toBe(true);
  expect(within(yaml).getByText("8 lines · 2 errors")).toBeTruthy();
  const line8 = document.getElementById("config-line-8")!;
  expect(line8.textContent).toBe("8  review: { agent: codex }");
  expect(line8.nextElementSibling!.textContent).toContain("review is built in");
  expect(document.getElementById("config-line-6")!.nextElementSibling!.textContent).toContain(
    "refused: the operator's grants",
  );
  // A fine line has no message under it.
  expect(document.getElementById("config-line-2")!.nextElementSibling!.id).toBe("config-line-3");
  // Folded by hand (its toggle event comes after the click), then opened by a line's link.
  const toggled = new Promise((resolve) =>
    yaml.addEventListener("toggle", resolve, { once: true }),
  );
  fireEvent.click(yaml.querySelector("summary")!);
  await toggled;
  expect(yaml.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "line 8" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith("config-line-8"));
  expect(yaml.open).toBe(true);
});

test("what its runs get: each value's source, filtered by it, the refused ones apart", async () => {
  panel();
  await screen.findByRole("alert");
  const settings = () => screen.getByRole("list", { name: "Settings" });
  expect(within(settings()).getAllByRole("listitem")).toHaveLength(SETTINGS.length);
  const show = screen.getByRole("group", { name: "Show" });
  expect(within(show).getByRole("button", { name: /Refused/ }).textContent).toBe("Refused 1");
  // No unknown value: no filter for them.
  expect(within(show).queryByRole("button", { name: /Unknown/ })).toBeNull();
  fireEvent.click(within(show).getByRole("button", { name: /Refused/ }));
  const refused = within(settings()).getAllByRole("listitem");
  expect(refused.map((r) => r.querySelector("code")!.textContent)).toEqual(["dockerfile"]);
  fireEvent.click(within(show).getByRole("button", { name: /From the repo/ }));
  expect(within(settings()).getAllByRole("listitem")).toHaveLength(4);
  // The grant's switches, on or off.
  const switches = screen.getByRole("list", { name: "Switches" });
  expect(within(switches).getByText("allow_research").nextElementSibling!.textContent).toBe("on");
  expect(within(switches).getByText("allow_dockerfile").nextElementSibling!.textContent).toBe(
    "off",
  );
});

test("a fine config: its banner, the facts at a glance, and the details folded", async () => {
  config = FINE;
  panel();
  expect((await screen.findByRole("status")).textContent).toContain(
    "Everything is fine: runs start here",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  const facts = screen.getByLabelText("At a glance");
  expect(facts.textContent).toContain("Runs withopus · high effort");
  expect(facts.textContent).toContain("In parallel1 · MAX_PARALLEL is 2");
  expect(facts.textContent).toContain("Who can triggeralice, bob");
  expect(facts.textContent).toContain("Hosts · mounts2 · 1");
  // What the repo sets is open, its own values first.
  const runs = fold(/What its runs get/);
  expect(runs.open).toBe(true);
  expect(within(runs).getByText("6 settings · 4 from the repo")).toBeTruthy();
  const settings = within(runs).getByRole("list", { name: "Settings" });
  expect(within(settings).getAllByRole("listitem")).toHaveLength(4);
  fireEvent.click(within(runs).getByRole("button", { name: "Show the 2 more from the operator" }));
  expect(within(settings).getAllByRole("listitem")).toHaveLength(6);
  // The repo asks for a mount: open. The file: folded.
  expect(fold(/Hosts, mounts and the operator's grant/).open).toBe(true);
  expect(fold(/\.deckhand\.yaml/).open).toBe(false);
  // A link of the page opens its fold.
  const toc = screen.getByRole("navigation", { name: "On this page" });
  fireEvent.click(within(toc).getByRole("button", { name: ".deckhand.yaml" }));
  await waitFor(() => expect(fold(/\.deckhand\.yaml/).open).toBe(true));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith("config-yaml"));
});

test("a fine config without mounts folds its hosts and grant too", async () => {
  config = { ...FINE, effective: { ...FINE.effective, mounts: [] } };
  panel();
  await screen.findByText(/Everything is fine/);
  const access = fold(/Hosts, mounts and the operator's grant/);
  expect(access.open).toBe(false);
  expect(within(access).getByText("2 hosts · no mounts · research on")).toBeTruthy();
  const toc = screen.getByRole("navigation", { name: "On this page" });
  expect(within(toc).queryByRole("button", { name: "Host mounts" })).toBeNull();
  fireEvent.click(within(toc).getByRole("button", { name: "The operator's grant" }));
  await waitFor(() => expect(access.open).toBe(true));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith("config-grant"));
});
