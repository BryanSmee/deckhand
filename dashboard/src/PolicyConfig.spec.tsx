// A repository's Policies tab against a fake api/repos/<repo>/config: a check that fails (the
// banner, the decision cards and the file's row say so, the error links to its line), each
// layer's allow and deny rules per decision, a Deckhand file the operator's replaces struck
// through, policies that compile, none at all.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { ConfigPanel } from "./ConfigPanel";
import { makePolicyFile, mockApi } from "./testUtils";
import type { Policies, RepoConfig } from "./types";

const PAYMENTS = `package deckhand

# Medium findings in payments code need a human.
deny_merge contains msg if {
  some f in input.review.findings
  f.severity == "medium"
  startswith(f.path, "src/payments/"
  msg := sprintf("medium finding in payments code: %s:%d", [f.path, f.line])
}
`;

const blob = (name: string) => `https://github.com/acme/app/blob/main/.deckhand/policy/${name}`;

// Deckhand's allow.rego, as the image ships it.
const ALLOW_ALL = [
  "package deckhand",
  ...["merge", "review", "fix", "link_branch", "request_review", "github"].map(
    (d) => `\nallow_${d} := true`,
  ),
].join("\n");
const allowFile = makePolicyFile({
  name: "allow.rego",
  source: "deckhand",
  rules: [...ALLOW_ALL.matchAll(/^allow_\w+/gm)].map((m) => m[0]),
  text: ALLOW_ALL,
});

// The reference's: the operator's size.rego and the repo's, each in its layer; payments.rego
// doesn't compile.
const POLICIES: Policies = {
  files: [
    allowFile,
    makePolicyFile({ name: "fridays.rego", source: "operator", rules: ["deny_merge"] }),
    makePolicyFile({ name: "size.rego", source: "operator", rules: ["deny_merge"] }),
    makePolicyFile({
      name: "size.rego",
      rules: ["deny_merge"],
      url: blob("size.rego"),
      text: 'package deckhand\n\ndeny_merge contains "too big" if input.pr.additions > 400\n',
    }),
    makePolicyFile({
      name: "payments.rego",
      rules: ["deny_merge"],
      url: blob("payments.rego"),
      text: PAYMENTS,
    }),
    makePolicyFile({ name: "wip.rego", rules: ["deny_review"], url: blob("wip.rego") }),
  ],
  errors: [
    {
      layer: "repo",
      file: "payments.rego",
      row: 7,
      message: 'rego_parse_error: unexpected newline, expecting ")"',
      text: 'policy error: payments.rego:7: rego_parse_error: unexpected newline, expecting ")"',
    },
  ],
  warnings: [],
};

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
  file: {
    text: "users: [alice]\n",
    sha: "c03e7a1f00",
    url: "https://github.com/acme/app/blob/main/.deckhand.yaml",
    editUrl: "https://github.com/acme/app/edit/main/.deckhand.yaml",
  },
  errors: [],
  warnings: [],
  grantsError: null,
  effective: { settings: [], hosts: [], mounts: [], grant: null },
  policies: POLICIES,
  readAt: Date.now(),
};

let policies: Policies;
const scrolled = vi.fn();
beforeEach(() => {
  policies = POLICIES;
  mockApi({ "api/repos/acme/app/config": () => ({ ...CONFIG, policies, readAt: Date.now() }) });
  scrolled.mockClear();
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this.id);
  };
});

const panel = (tab?: "policies") =>
  render(
    <ConfigPanel
      repo="acme/app"
      tab={tab}
      row={null}
      onRow={() => {}}
      onBack={() => {}}
      now={Date.now()}
    />,
  );

// A decision's card by its name (its rule is a span of its own).
const card = (name: string) =>
  screen
    .getByText((_, el) => !!el?.matches("[class*=key]") && el.textContent!.startsWith(`${name} · `))
    .closest("div")!;
const rows = () =>
  within(screen.getByRole("list", { name: "Policy files" })).getAllByRole("listitem");
const source = (path: string) =>
  screen.getByText(path, { selector: "summary span" }).closest("details")!;

test("a policy that doesn't compile: the badge, the banner, the cards and its row say so", async () => {
  panel("policies");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "payments.rego:7 doesn't compile: every decision a policy is asked for refuses",
  );
  expect(alert.textContent).toContain("runs' writes to GitHub");
  expect(alert.textContent).toContain("Runs started by a comment still start.");
  // The header's badge and the tab's count.
  expect(screen.getByText("1 policy doesn't compile")).toBeTruthy();
  const tabs = screen.getByRole("navigation", { name: "Repository settings" });
  expect(within(tabs).getByRole("link", { name: "Policies 1" }).getAttribute("aria-current")).toBe(
    "page",
  );
  // Every decision refuses, the one without rules too.
  const merge = card("Auto-merge");
  expect(within(merge).getByText("Refused")).toBeTruthy();
  expect(merge.textContent).toContain("Every auto-merge is refused until payments.rego compiles.");
  // Each layer's rules: the operator's allow and denies, the repo's denies.
  expect(merge.textContent).toContain(
    "Operator: allow_merge ×1 (allow.rego) · deny_merge ×2 (fridays.rego, size.rego)",
  );
  expect(merge.textContent).toContain(
    "Repo: no allow rule · deny_merge ×2 (size.rego, payments.rego)",
  );
  expect(card("Automatic review").textContent).toContain("/mode review still runs");
  const fix = card("Fix run");
  expect(within(fix).getByText("Refused")).toBeTruthy();
  expect(fix.textContent).toContain("Every fix run is refused until payments.rego compiles.");
  expect(fix.textContent).toContain("Operator: allow_fix ×1 (allow.rego) · no deny_fix");
  expect(within(card("GitHub writes and checks")).getByText("Refused")).toBeTruthy();
  expect(within(card("Linked branch")).getByText("Refused")).toBeTruthy();
  expect(card("Reviewers").textContent).toContain("No reviewer is requested until");
  // Its row, and its source: open, the bad line marked with its error.
  const payments = rows().find((r) => r.textContent!.includes("payments.rego"))!;
  expect(within(payments).getByText("Error")).toBeTruthy();
  expect(payments.className).toMatch(/bad/);
  const file = source(".deckhand/policy/payments.rego");
  expect(file.open).toBe(true);
  expect(within(file).getByText("9 lines · 1 error")).toBeTruthy();
  expect(within(file).getByText(/^rego_parse_error: unexpected newline/)).toBeTruthy();
  expect(within(file).getByRole("link", { name: "Edit on GitHub" }).getAttribute("href")).toBe(
    "https://github.com/acme/app/edit/main/.deckhand/policy/payments.rego",
  );
  expect(source(".deckhand/policy/wip.rego").open).toBe(false);
  // The banner's link shows the line.
  fireEvent.click(within(alert).getByRole("button", { name: "Line 7 ↓" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith("policy-repo-payments.rego-line-7"));
});

test("an operator's file and a repo's of the same name: both evaluated, each in its layer", async () => {
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  const names = rows().map((r) => r.querySelector("[class*=path]")!.textContent);
  expect(names).toEqual([
    "deckhand/policy/allow.rego",
    "grants/policy/fridays.rego",
    "grants/policy/size.rego",
    ".deckhand/policy/size.rego",
    ".deckhand/policy/payments.rego",
    ".deckhand/policy/wip.rego",
  ]);
  const [allow, fridays, operator, size, payments] = rows();
  expect(allow.textContent).toContain("allow_merge ×1, allow_review ×1");
  expect(fridays.textContent).toContain("Default, kept");
  expect(operator.querySelector("s")).toBeNull();
  expect(size.textContent).toContain("Added");
  expect(size.textContent).toContain("deny_merge ×1");
  expect(payments.textContent).toContain("Added");
  // The repo's error is its own file's, not the operator's of another name.
  expect(within(operator).getByText("Yes")).toBeTruthy();
  expect(
    screen.getByText(
      "6 files · 1 from Deckhand, 2 from the operator, 3 from the repo · Deckhand's and the operator's merged by name, the repo's apart",
    ),
  );
});

test("an error placed in a file of the same name in the other layer: not this one's", async () => {
  policies = {
    ...POLICIES,
    errors: [{ ...POLICIES.errors[0], layer: "operator", file: "size.rego", row: 2 }],
  };
  panel("policies");
  await screen.findByRole("alert");
  const [, , operator, repo] = rows();
  expect(within(operator).getByText("Error")).toBeTruthy();
  expect(within(repo).getByText("Yes")).toBeTruthy();
});

test("no allow rule of the operator's: the decision is never allowed", async () => {
  policies = { files: POLICIES.files.slice(1, 3), errors: [], warnings: [] };
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  const merge = card("Auto-merge");
  expect(within(merge).getByText("Never allowed")).toBeTruthy();
  expect(merge.textContent).toContain(
    "Every auto-merge is refused while no allow rule of the operator's matches it.",
  );
  // A repo's allow rule: for its own modes, ignored for a decision none of them makes.
  policies = {
    files: [
      ...POLICIES.files.slice(0, 1),
      makePolicyFile({ name: "modes.rego", rules: ["allow_github", "allow_merge"] }),
    ],
    errors: [],
    warnings: [],
  };
  panel("policies");
  await waitFor(() =>
    expect(screen.getAllByText(/modes\.rego\), for its own modes/).length).toBe(1),
  );
  expect(screen.getAllByText(/ignored, no mode of the repo's makes it/).length).toBe(1);
});

test("Deckhand's default files: under the operator's, which replace them by name; the repo's apart", async () => {
  const gh = 'package deckhand\n\ndeny_github contains "x" if input.custom_mode\n';
  const drop = "package deckhand\n";
  policies = {
    files: [
      allowFile,
      makePolicyFile({ name: "github.rego", source: "deckhand", rules: ["deny_github"], text: gh }),
      makePolicyFile({
        name: "gh-a.rego",
        source: "deckhand",
        active: false,
        rules: ["deny_github"],
      }),
      makePolicyFile({
        name: "gh-b.rego",
        source: "deckhand",
        active: false,
        rules: ["deny_github"],
      }),
      makePolicyFile({ name: "gh-a.rego", source: "operator", replaces: "deckhand", text: drop }),
      makePolicyFile({ name: "gh-b.rego", source: "operator", replaces: "deckhand" }),
      makePolicyFile({ name: "gh-b.rego", url: blob("gh-b.rego"), text: drop }),
    ],
    errors: [],
    warnings: [],
  };
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  expect(rows().map((r) => r.querySelector("[class*=path]")!.textContent)).toEqual([
    "deckhand/policy/allow.rego",
    "deckhand/policy/github.rego",
    "grants/policy/gh-a.rego",
    "deckhand/policy/gh-a.rego",
    "grants/policy/gh-b.rego",
    "deckhand/policy/gh-b.rego",
    ".deckhand/policy/gh-b.rego",
  ]);
  expect(rows().map((r) => r.querySelector("[class*=effect]")!.textContent)).toEqual([
    "Default, kept",
    "Default, kept",
    "Replaces Deckhand's",
    "Replaced by the operator's",
    "Replaces Deckhand's",
    "Replaced by the operator's",
    "Added",
  ]);
  expect(
    screen.getByText(
      "7 files · 4 from Deckhand, 2 from the operator, 1 from the repo · Deckhand's and the operator's merged by name, the repo's apart",
    ),
  );
  const github = card("GitHub writes and checks");
  expect(within(github).getByText("Active")).toBeTruthy();
  // No allow_run here (Deckhand's run.rego isn't in this list): never allowed.
  const run = card("Runs people start");
  expect(within(run).getByText("Never allowed")).toBeTruthy();
  expect(run.textContent).toContain("No run a person asks for starts");
  const runInput = screen.getByRole("link", { name: "The run input" });
  expect(runInput.getAttribute("href")).toMatch(/docs\/repo-config\.md#the-run-input$/);
  expect(runInput.closest("p")!.textContent).toMatch(/trigger.*sender.*target/);
  // The same rule refuses reads of CI's checks too.
  expect(github.textContent).toContain("its reads of CI's checks (read_checks");
  // What deny_github reads of the run, and where its input is documented.
  const input = screen.getByRole("link", { name: "The GitHub input" });
  expect(input.getAttribute("href")).toMatch(/docs\/repo-config\.md#the-github-input$/);
  expect(input.closest("p")!.textContent).toMatch(/read_checks, no target or change/);
  expect(input.closest("p")!.textContent).toMatch(/custom_mode.*light.*reason/);
  expect(source("deckhand/policy/gh-a.rego").textContent).toContain(
    "replaced by the operator's: not evaluated",
  );
  expect(source("grants/policy/gh-b.rego").textContent).toContain("replaces Deckhand's gh-b.rego");
  expect(source(".deckhand/policy/gh-b.rego").textContent).not.toContain("replace");
});

test("policies that compile: no banner, each decision active or without rules, warnings apart", async () => {
  policies = { ...POLICIES, errors: [], warnings: ["wip.rego: `deny_wip` isn't a rule"] };
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/doesn't compile/)).toBeNull();
  expect(within(card("Auto-merge")).getByText("Active")).toBeTruthy();
  expect(within(card("Fix run")).getByText("No deny rule")).toBeTruthy();
  expect(within(card("Reviewers")).getByText("No deny rule")).toBeTruthy();
  expect(within(card("Runs people start")).getByText("Never allowed")).toBeTruthy();
  expect(rows().every((r) => /Yes|—/.test(r.textContent!))).toBe(true);
  expect(screen.getByLabelText("Policy warnings").textContent).toContain("deny_wip");
  // Every source folded.
  expect(document.querySelectorAll("details[open]")).toHaveLength(0);
});

test("a repo's ignored allow rule: said and marked on its line, but nothing is refused", async () => {
  const text =
    "merge.rego:3: `allow_merge` is ignored: a repository's allow rules count only for its own modes, and only the operator's allow the merge";
  policies = {
    files: [
      allowFile,
      makePolicyFile({
        name: "merge.rego",
        rules: ["allow_merge"],
        text: "package deckhand\n\nallow_merge := true\n",
      }),
    ],
    errors: [
      { layer: "repo", file: "merge.rego", row: 3, message: text.slice(14), text, ignored: true },
    ],
    warnings: [],
  };
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/doesn't compile|Policy error/)).toBeNull();
  const tabs = screen.getByRole("navigation", { name: "Repository settings" });
  expect(within(tabs).getByRole("link", { name: "Policies" })).toBeTruthy();
  const merge = card("Auto-merge");
  expect(within(merge).queryByText("Refused")).toBeNull();
  expect(merge.textContent).toContain("ignored, no mode of the repo's makes it");
  expect(screen.getByLabelText("Policy warnings").textContent).toContain(`Ignored · ${text}`);
  const [, row] = rows();
  expect(within(row).getByText("Yes")).toBeTruthy();
  // Its line is marked, its source open.
  const file = source(".deckhand/policy/merge.rego");
  expect(file.open).toBe(true);
  expect(within(file).getByText(/^`allow_merge` is ignored/)).toBeTruthy();
});

test("the banner's line link: the file of the error's layer, when Deckhand's has its name", async () => {
  const text = "policy error: review.rego:4: rego_parse_error: unexpected eof token";
  policies = {
    files: [
      makePolicyFile({ name: "review.rego", source: "deckhand", rules: ["deny_review"] }),
      makePolicyFile({ name: "review.rego", text: "package deckhand\n\n\ndeny_review contains\n" }),
    ],
    errors: [{ layer: "repo", file: "review.rego", row: 4, message: text.slice(31), text }],
    warnings: [],
  };
  panel("policies");
  const alert = await screen.findByRole("alert");
  fireEvent.click(within(alert).getByRole("button", { name: "Line 4 ↓" }));
  await waitFor(() => expect(scrolled).toHaveBeenCalledWith("policy-repo-review.rego-line-4"));
  expect(source(".deckhand/policy/review.rego").open).toBe(true);
  expect(source("deckhand/policy/review.rego").open).toBe(false);
});

test("an error placed in no file: the check's, every file's state unknown", async () => {
  const text = "policy error: the policies' check took too long";
  policies = { ...POLICIES, errors: [{ file: null, row: null, message: text, text }] };
  panel("policies");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The policies can't be checked");
  expect(alert.textContent).toContain(text);
  expect(screen.getByText("Policy error")).toBeTruthy();
  expect(within(rows()[0]).getByText("Unknown")).toBeTruthy();
});

test("no policy anywhere: one line, and the Config tab says nothing of them", async () => {
  policies = { files: [], errors: [], warnings: [] };
  const { unmount } = panel("policies");
  expect(await screen.findByText("No policies: only the built-in gates decide.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Policy files" })).toBeNull();
  unmount();
  policies = POLICIES;
  panel();
  // A policy error doesn't stop runs: the config is fine, the badge says the rest.
  await screen.findByText(/Everything is fine/);
  expect(screen.getByText("1 policy doesn't compile")).toBeTruthy();
  expect(screen.queryByText(/Policy files/)).toBeNull();
});

test("try them: the command copied", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  panel("policies");
  fireEvent.click(await screen.findByRole("button", { name: "Copy the command" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(writeText).toHaveBeenCalledWith("Deckhand /mode policy");
});

test("the run decision with Deckhand's run.rego: no deny rule, but its allow rules still refuse some modes", async () => {
  policies = {
    ...POLICIES,
    errors: [],
    files: [
      ...POLICIES.files,
      makePolicyFile({ name: "run.rego", source: "deckhand", rules: ["allow_run"] }),
    ],
  };
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  const run = card("Runs people start");
  expect(within(run).getByText("No deny rule")).toBeTruthy();
  expect(run.textContent).toContain(
    "Deckhand's run.rego keeps brainstorms, /stop and onboarding on issues",
  );
});
