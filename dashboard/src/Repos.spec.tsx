// The repositories page against a fake api/repos: statuses, the button, the row switching.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useRepos } from "./api";
import { Dashboard } from "./App";
import { Repos } from "./Repos";
import type { Repo } from "./types";

const repo = (name: string, extra: Partial<Repo> = {}): Repo => ({
  repo: name,
  url: `https://github.com/${name}`,
  private: false,
  issues: true,
  status: "not-onboarded",
  issue: null,
  ...extra,
});

const REPOS: Repo[] = [
  repo("org/api", { status: "configured" }),
  repo("org/app"),
  repo("org/docs", {
    status: "onboarding",
    issue: { number: 7, url: "https://github.com/org/docs/issues/7" },
  }),
  repo("org/wiki", { issues: false }),
];

let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  history.replaceState(null, "", "/");
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url === "api/repos") return Response.json({ repos: REPOS });
    if (url === "api/repos/org/app/onboard") {
      return Response.json({
        opened: true,
        repo: repo("org/app", {
          status: "onboarding",
          issue: { number: 12, url: "https://github.com/org/app/issues/12" },
        }),
      });
    }
    return Response.json({ error: "Its issues are disabled." }, { status: 409 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function Page() {
  return <Repos list={useRepos()} onBack={() => {}} />;
}

const row = (name: string) => screen.getByRole("link", { name }).closest("li")!;

test("each repository with its status; the ones to onboard first", async () => {
  render(<Page />);
  await screen.findByRole("link", { name: "org/app" });
  expect(screen.getAllByRole("listitem").map((li) => li.querySelector("a")!.textContent)).toEqual([
    "org/app",
    "org/wiki",
    "org/docs",
    "org/api",
  ]);
  expect(within(row("org/api")).getByText("Configured")).toBeTruthy();
  expect(within(row("org/api")).queryByRole("button")).toBeNull();
  expect(within(row("org/docs")).getByRole("link", { name: "Issue #7" }).getAttribute("href")).toBe(
    "https://github.com/org/docs/issues/7",
  );
  // Issues off: no button, the reason instead.
  expect(within(row("org/wiki")).queryByRole("button")).toBeNull();
  expect(within(row("org/wiki")).getByText(/Issues are disabled/)).toBeTruthy();
  expect(screen.getByText(/2 without a .deckhand.yaml/)).toBeTruthy();
});

test("Start onboarding posts, and the row switches to its issue", async () => {
  render(<Page />);
  await screen.findByRole("link", { name: "org/app" });
  fireEvent.click(within(row("org/app")).getByRole("button", { name: "Start onboarding" }));
  const issue = await within(row("org/app")).findByRole("link", { name: "Issue #12" });
  expect(issue.getAttribute("href")).toBe("https://github.com/org/app/issues/12");
  expect(within(row("org/app")).getByText("Onboarding")).toBeTruthy();
  expect(calls).toContainEqual({ url: "api/repos/org/app/onboard", method: "POST" });
});

test("the header counts the repositories not onboarded and opens the page", async () => {
  const list = {
    repos: REPOS,
    error: null,
    starting: null,
    failed: null,
    onboard: async () => {},
  };
  render(<Dashboard state={null} error={null} repos={list} />);
  const link = screen.getByRole("link", { name: /Repositories/ });
  expect(link.textContent).toBe("Repositories2");
  expect(screen.queryByRole("heading", { name: "Repositories" })).toBeNull();
  history.replaceState(null, "", "#/repositories");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => screen.getByRole("heading", { name: "Repositories" }));
  expect(screen.queryByRole("tablist")).toBeNull();
});
