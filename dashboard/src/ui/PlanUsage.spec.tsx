// The plans' usage bars: nothing without a reading, a bar per window with its label, the tone
// of a limit reached, a reading from before its window's reset.
import { render, screen } from "@testing-library/preact";
import { expect, test } from "vitest";
import { makePlan } from "../testUtils";
import { PlanBars, windowTone } from "./PlanUsage";

const NOW = 1_800_000_000_000;
const bars = () => screen.queryAllByRole("img").map((b) => b.getAttribute("aria-label"));

test("no plans, or a plan without readings yet: nothing at all", () => {
  const { container } = render(<PlanBars plans={undefined} now={NOW} form="compact" />);
  expect(container.innerHTML).toBe("");
  render(<PlanBars plans={[makePlan({ windows: [], updatedAt: null })]} now={NOW} />);
  expect(screen.queryByRole("group")).toBeNull();
});

test("one plan: a labelled bar per window, its percentage and reset in its label", () => {
  render(<PlanBars plans={[makePlan()]} now={NOW} form="compact" />);
  expect(screen.getByRole("group", { name: "Plan usage" }).textContent).toBe(
    "Claude5h 42 %week 18 %",
  );
  const [fiveHour, week] = bars();
  expect(fiveHour).toMatch(/^Claude 5h: 42 % used, resets (today )?\d/);
  expect(week).toMatch(/^Claude week: 18 % used, resets /);
  expect(windowTone(makePlan(), makePlan().windows[0], NOW)).toBe("ok");
  expect(windowTone(makePlan(), { name: "5h", used: 0.8, resetsAt: null, at: NOW }, NOW)).toBe(
    "warn",
  );
});

test("the phone's bar: each plan's most used window", () => {
  const codex = makePlan({
    plan: "codex",
    label: "Codex",
    windows: [
      { name: "5h", used: 0.1, resetsAt: NOW + 1000, at: NOW },
      { name: "7d", used: 0.6, resetsAt: NOW + 2000, at: NOW },
    ],
  });
  render(<PlanBars plans={[makePlan(), codex]} now={NOW} form="phone" />);
  expect(bars().map((b) => b!.split(":")[0])).toEqual(["Claude 5h", "Codex week"]);
});

test("a limited plan: its full window in the danger tone, until when in its label", () => {
  const plan = makePlan({
    limited: true,
    limitedUntil: NOW + 3_600_000,
    windows: [
      { name: "5h", used: 1, resetsAt: NOW + 3_600_000, at: NOW },
      { name: "7d", used: 0.5, resetsAt: NOW + 86_400_000, at: NOW },
    ],
  });
  render(<PlanBars plans={[plan]} now={NOW} />);
  expect(screen.getByText("limit reached")).toBeTruthy();
  expect(bars()[0]).toMatch(/100 % used, limit reached until /);
  expect(windowTone(plan, plan.windows[0], NOW)).toBe("danger");
  expect(windowTone(plan, plan.windows[1], NOW)).toBe("ok");
});

test("a reading from before its window's reset is stale, and says when it was read", () => {
  const plan = makePlan({
    windows: [{ name: "5h", used: 0.9, resetsAt: NOW - 60_000, at: NOW - 2 * 3_600_000 }],
  });
  render(<PlanBars plans={[plan]} now={NOW} form="compact" />);
  expect(windowTone(plan, plan.windows[0], NOW)).toBe("stale");
  expect(bars()[0]).toBe(
    "Claude 5h: 90 % used, read before its last reset, so no longer current, as of 2 h ago",
  );
});
