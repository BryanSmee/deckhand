import { expect, test } from "vitest";
import { formatRoute, parseRoute } from "./route";

test("tabs, tasks and runs in the address, both ways", () => {
  const route = { repo: "org/repo", task: "org/repo#12", run: "org-repo-12-1000" };
  expect(formatRoute(route)).toBe("#/org/repo?task=org%2Frepo%2312&run=org-repo-12-1000");
  expect(parseRoute(formatRoute(route))).toEqual(route);
  expect(formatRoute({ repo: null, task: null, run: null })).toBe("#/all");
  expect(parseRoute("#/all")).toEqual({ repo: null, task: null, run: null });
  // A run without its task means nothing.
  expect(formatRoute({ repo: null, task: null, run: "x" })).toBe("#/all");
});

test("links from before the tabs open their task in All", () => {
  expect(parseRoute("#task=org%2Frepo%2312&run=r1")).toEqual({
    repo: null,
    task: "org/repo#12",
    run: "r1",
  });
  expect(parseRoute("")).toEqual({ repo: null, task: null, run: null });
});

test("anything else in the path is All", () => {
  expect(parseRoute("#/not a repo")).toEqual({ repo: null, task: null, run: null });
});

test("the repositories page", () => {
  const route = { repo: null, task: null, run: null, page: "repositories" as const };
  expect(formatRoute(route)).toBe("#/repositories");
  expect(parseRoute("#/repositories")).toEqual(route);
});

test("a repository's config on the repositories page", () => {
  const route = {
    repo: null,
    task: null,
    run: null,
    page: "repositories" as const,
    config: "org/app",
  };
  expect(formatRoute(route)).toBe("#/repositories/org/app");
  expect(parseRoute("#/repositories/org/app")).toEqual(route);
});

test("the graph, of every repo or one", () => {
  const all = { repo: null, task: null, run: null, page: "graph" as const };
  expect(formatRoute(all)).toBe("#/graph");
  expect(parseRoute("#/graph")).toEqual(all);
  const one = { ...all, repo: "org/app" };
  expect(formatRoute(one)).toBe("#/graph/org/app");
  expect(parseRoute("#/graph/org/app")).toEqual(one);
});
