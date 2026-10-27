import { expect, test } from "vitest";
import { formatRoute, parseRoute } from "./route";

const none = { task: null, run: null };

test("tasks and runs in the address, both ways", () => {
  const route = { repo: "org/repo", task: "org/repo#12", run: "org-repo-12-1000" };
  expect(formatRoute(route)).toBe("#/org/repo?task=org%2Frepo%2312&run=org-repo-12-1000");
  expect(parseRoute(formatRoute(route))).toEqual(route);
  expect(formatRoute({ repo: null, ...none })).toBe("#/");
  expect(parseRoute("#/")).toEqual({ repo: null, ...none });
  const all = { repo: null, task: "org/repo#12", run: null };
  expect(formatRoute(all)).toBe("#/?task=org%2Frepo%2312");
  expect(parseRoute(formatRoute(all))).toEqual(all);
  // A run without its task means nothing.
  expect(formatRoute({ repo: null, task: null, run: "x" })).toBe("#/");
});

test("a repository's board, and every repository's", () => {
  const route = { repo: "org/app", ...none, page: "board" as const };
  expect(formatRoute(route)).toBe("#/org/app/board");
  expect(parseRoute("#/org/app/board")).toEqual(route);
  const all = { ...route, repo: null };
  expect(formatRoute(all)).toBe("#/board");
  expect(parseRoute("#/board")).toEqual(all);
});

test("settings: the repositories, and one's config", () => {
  const list = { repo: null, ...none, page: "settings" as const };
  expect(formatRoute(list)).toBe("#/settings/repositories");
  expect(parseRoute("#/settings/repositories")).toEqual(list);
  // Its only page yet: the others open it.
  expect(parseRoute("#/settings")).toEqual(list);
  expect(parseRoute("#/settings/preferences")).toEqual(list);
  const config = { ...list, config: "org/app" };
  expect(formatRoute(config)).toBe("#/settings/repositories/org/app");
  expect(parseRoute("#/settings/repositories/org/app")).toEqual(config);
});

// Each old address parses to the view it showed, under its new address.
test.each([
  ["#/all", "#/"],
  ["#/all?task=org%2Frepo%2312&run=r1", "#/?task=org%2Frepo%2312&run=r1"],
  ["#/repositories", "#/settings/repositories"],
  ["#/repositories/org/app", "#/settings/repositories/org/app"],
  ["#/graph/org/app", "#/org/app/board"],
  // Every repository's graph, until the Overview replaces it.
  ["#/graph", "#/board"],
  // From before the tabs.
  ["#task=org%2Frepo%2312&run=r1", "#/?task=org%2Frepo%2312&run=r1"],
  ["", "#/"],
])("%s leads to %s", (old, now) => {
  expect(formatRoute(parseRoute(old))).toBe(now);
  expect(parseRoute(old)).toEqual(parseRoute(now));
});

test("anything else in the path is All", () => {
  expect(parseRoute("#/not a repo")).toEqual({ repo: null, ...none });
  expect(parseRoute("#/org/app/elsewhere")).toEqual({ repo: null, ...none });
});
