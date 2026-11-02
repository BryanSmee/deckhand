import { expect, test } from "vitest";
import { formatRoute, isOverview, parseRoute } from "./route";

const none = { task: null, run: null };

test("tasks and runs in the address, both ways", () => {
  const route = { repo: "org/repo", task: "org/repo#12", run: "org-repo-12-1000" };
  expect(formatRoute(route)).toBe("#/org/repo?task=org%2Frepo%2312&run=org-repo-12-1000");
  expect(parseRoute(formatRoute(route))).toEqual(route);
  const all = { repo: null, task: "org/repo#12", run: null, page: "tasks" as const };
  expect(formatRoute(all)).toBe("#/tasks?task=org%2Frepo%2312");
  expect(parseRoute(formatRoute(all))).toEqual(all);
  expect(formatRoute({ repo: null, ...none, page: "tasks" })).toBe("#/tasks");
  expect(parseRoute("#/tasks")).toEqual({ repo: null, ...none, page: "tasks" });
  // A run without its task means nothing.
  expect(formatRoute({ repo: null, task: null, run: "x", page: "tasks" })).toBe("#/tasks");
  expect(parseRoute("#/org/repo?run=x")).toEqual({ repo: "org/repo", ...none });
});

test("the Overview is All's own page", () => {
  expect(formatRoute({ repo: null, ...none })).toBe("#/");
  expect(parseRoute("#/")).toEqual({ repo: null, ...none });
  expect(isOverview(parseRoute("#/"))).toBe(true);
  expect(isOverview(parseRoute("#/tasks"))).toBe(false);
  expect(isOverview(parseRoute("#/org/app"))).toBe(false);
});

test("a repository's board, and none for every repository", () => {
  const route = { repo: "org/app", ...none, page: "board" as const };
  expect(formatRoute(route)).toBe("#/org/app/board");
  expect(parseRoute("#/org/app/board")).toEqual(route);
  expect(formatRoute({ ...route, repo: null })).toBe("#/");
  expect(parseRoute("#/board")).toEqual({ repo: null, ...none });
});

test("settings: the repositories, and one's config", () => {
  const list = { repo: null, ...none, page: "settings" as const };
  expect(formatRoute(list)).toBe("#/settings/repositories");
  expect(parseRoute("#/settings/repositories")).toEqual(list);
  expect(parseRoute("#/settings")).toEqual(list);
  expect(parseRoute("#/settings/elsewhere")).toEqual(list);
  for (const section of ["preferences", "clients", "server"] as const) {
    const tab = { ...list, section };
    expect(formatRoute(tab)).toBe(`#/settings/${section}`);
    expect(parseRoute(`#/settings/${section}`)).toEqual(tab);
  }
  const config = { ...list, config: "org/app" };
  expect(formatRoute(config)).toBe("#/settings/repositories/org/app");
  expect(parseRoute("#/settings/repositories/org/app")).toEqual(config);
  const policies = { ...config, configTab: "policies" as const };
  expect(formatRoute(policies)).toBe("#/settings/repositories/org/app/policies");
  expect(parseRoute("#/settings/repositories/org/app/policies")).toEqual(policies);
  const capabilities = { ...config, configTab: "capabilities" as const };
  expect(formatRoute(capabilities)).toBe("#/settings/repositories/org/app/capabilities");
  expect(parseRoute("#/settings/repositories/org/app/capabilities")).toEqual(capabilities);
  // A tab without a repository: the list.
  expect(formatRoute({ ...list, configTab: "policies" })).toBe("#/settings/repositories");
});

// Each old address parses to the view it showed, under its new address.
test.each([
  ["#/all", "#/"],
  ["#/all?task=org%2Frepo%2312&run=r1", "#/tasks?task=org%2Frepo%2312&run=r1"],
  ["#/?task=org%2Frepo%2312", "#/tasks?task=org%2Frepo%2312"],
  ["#/repositories", "#/settings/repositories"],
  ["#/repositories/org/app", "#/settings/repositories/org/app"],
  ["#/graph/org/app", "#/org/app/board"],
  // Every repository's graph: the Overview replaced it.
  ["#/graph", "#/"],
  ["#/board", "#/"],
  // From before the tabs.
  ["#task=org%2Frepo%2312&run=r1", "#/tasks?task=org%2Frepo%2312&run=r1"],
  ["#task=", "#/"],
  ["", "#/"],
])("%s leads to %s", (old, now) => {
  expect(formatRoute(parseRoute(old))).toBe(now);
  expect(parseRoute(old)).toEqual(parseRoute(now));
});

test("anything else in the path is the Overview", () => {
  expect(parseRoute("#/not a repo")).toEqual({ repo: null, ...none });
  expect(parseRoute("#/org/app/elsewhere")).toEqual({ repo: null, ...none });
});
