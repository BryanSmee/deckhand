import { describe, expect, test } from "vitest";
import { fallbackName, laneName } from "./lanes";
import type { LaneLabel } from "./types";

const keys = ["acme/app#18", "acme/app#22", "acme/app#pr-23", "acme/app#24"];

describe("lane names", () => {
  test("nothing known: after its first issue", () => {
    expect(laneName(keys)).toEqual({ name: "#18 and 3 more", source: "fallback" });
    expect(laneName(["acme/app#pr-19"], {})).toEqual({ name: "#19", source: "fallback" });
    expect(fallbackName([])).toBe("");
  });

  test("a parent's title over an inbox's, a typed name over both", () => {
    const labels: Record<string, LaneLabel> = {
      "acme/app#18": { name: "Ideas inbox", source: "inbox" },
      "acme/app#24": { name: "Budgets", source: "parent" },
    };
    expect(laneName(keys, labels)).toEqual({ name: "Budgets", source: "parent" });
    labels["acme/app#22"] = { name: "Spending caps", source: "user", at: 5 };
    expect(laneName(keys, labels)).toEqual({ name: "Spending caps", source: "user" });
  });

  test("two typed names: the latest; two parents: the first issue's", () => {
    expect(
      laneName(keys, {
        "acme/app#18": { name: "Old", source: "user", at: 1 },
        "acme/app#24": { name: "New", source: "user", at: 9 },
      }).name,
    ).toBe("New");
    expect(
      laneName(keys, {
        "acme/app#22": { name: "Webhooks", source: "parent" },
        "acme/app#24": { name: "Budgets", source: "parent" },
      }).name,
    ).toBe("Webhooks");
  });
});
