// A repository's Policies tab against a fake api/repos/<repo>/config: a check that fails (the
// banner, the decision cards and the file's row say so, the error links to its line), a
// replaced operator file struck through next to the repo's, policies that compile, none at all.
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

// The reference's: the repo's size.rego replaces the operator's, payments.rego doesn't compile.
const POLICIES: Policies = {
  files: [
    makePolicyFile({ name: "fridays.rego", source: "operator", rules: ["deny_merge"] }),
    makePolicyFile({ name: "size.rego", source: "operator", active: false, rules: ["deny_merge"] }),
    makePolicyFile({
      name: "size.rego",
      replaces: true,
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

const card = (name: string) => screen.getByText(new RegExp(`^${name} · `)).closest("div")!;
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
  expect(merge.textContent).toContain("3 rules · fridays.rego, size.rego (repo), payments.rego");
  expect(card("Automatic review").textContent).toContain("/mode review still runs");
  const fix = card("Fix run");
  expect(within(fix).getByText("Refused")).toBeTruthy();
  expect(fix.textContent).toContain("No rule of its own, but refused too");
  expect(fix.textContent).toContain("none in any file");
  expect(within(card("GitHub writes")).getByText("Refused")).toBeTruthy();
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

test("a replaced operator file: struck through, next to the repo file that replaces it", async () => {
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  const names = rows().map((r) => r.querySelector("[class*=path]")!.textContent);
  expect(names).toEqual([
    "grants/policy/fridays.rego",
    ".deckhand/policy/size.rego",
    "grants/policy/size.rego",
    ".deckhand/policy/payments.rego",
    ".deckhand/policy/wip.rego",
  ]);
  const [fridays, size, replaced, payments] = rows();
  expect(fridays.textContent).toContain("Default, kept");
  expect(size.textContent).toContain("Replaces the operator's");
  expect(size.textContent).toContain("deny_merge ×1");
  expect(replaced.textContent).toContain("Replaced by the repo's");
  expect(replaced.querySelector("s")!.textContent).toBe("size.rego");
  expect(within(replaced).getByText("—")).toBeTruthy();
  expect(payments.textContent).toContain("Added");
  expect(screen.getByText("5 files · 2 from the operator, 3 from the repo · merged by name"));
});

test("policies that compile: no banner, each decision active or without rules, warnings apart", async () => {
  policies = { ...POLICIES, errors: [], warnings: ["wip.rego: `deny_wip` isn't a rule"] };
  panel("policies");
  await screen.findByRole("list", { name: "Policy files" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/doesn't compile/)).toBeNull();
  expect(within(card("Auto-merge")).getByText("Active")).toBeTruthy();
  expect(within(card("Fix run")).getByText("No rules")).toBeTruthy();
  expect(rows().every((r) => /Yes|—/.test(r.textContent!))).toBe(true);
  expect(screen.getByLabelText("Policy warnings").textContent).toContain("deny_wip");
  // Every source folded.
  expect(document.querySelectorAll("details[open]")).toHaveLength(0);
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
