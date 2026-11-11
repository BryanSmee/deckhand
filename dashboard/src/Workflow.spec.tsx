// The pull request lifecycle's graph (Workflow.tsx, workflowLayout.ts): each step in its state
// with its words, why steps don't run, a task's step highlighted with its real decisions, and
// where the arrows go.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { loopCounters } from "./ReviewLoop";
import { WORKFLOW } from "./shots";
import { makeTask, mockApi } from "./testUtils";
import type { PolicyDecision, RepoConfig, Workflow } from "./types";
import { TaskWorkflow, WorkflowGraph, WorkflowTab } from "./Workflow";
import { layoutWorkflow, NODE_H, withDecisions } from "./workflowLayout";

beforeEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const steps = () => within(screen.getByRole("list", { name: "The pull request lifecycle" }));

test("each step says its state and numbers; the refused and may-be-refused ones say why", () => {
  render(<WorkflowGraph workflow={WORKFLOW} />);
  const merge = steps().getByText("Auto-merge").closest("li")!;
  expect(merge.textContent).toContain("squash · 30 min");
  expect(merge.textContent).toContain("Refused");
  expect(merge.title).toBe("review.merge: not granted (auto_merge), nothing is merged");
  const review = steps().getByText("Review").closest("li")!;
  expect(review.textContent).toContain("Tolerates medium");
  expect(review.textContent).toContain("May be refused");
  // Off: grey, with the setting that turns it on.
  expect(steps().getByText("Rebase").closest("li")!.textContent).toContain("Off: conflicts");
  const notes = within(screen.getByRole("region", { name: "Why steps don't run" }));
  expect(notes.getByText("deny_review in review.rego (operator)")).toBeTruthy();
  expect(notes.getByText("review.merge: not granted (auto_merge), nothing is merged")).toBeTruthy();
  // Every arrow has its words.
  expect(screen.getAllByText("nothing pushed")).toHaveLength(2);
  expect(screen.getByText("CI failed")).toBeTruthy();
  // The arrows, for screen readers.
  const arrows = within(
    screen.getByRole("list", { name: "What moves a pull request between the steps" }),
  );
  expect(arrows.getByText("Review → Fix: blocking")).toBeTruthy();
  expect(
    arrows.getByText("Review → Done: nothing blocking / rounds out / no fix run"),
  ).toBeTruthy();
});

test("the Workflow tab says the policies were asked about a sample, or weren't", () => {
  const config = { workflow: WORKFLOW } as RepoConfig;
  render(<WorkflowTab config={config} />);
  expect(screen.getByText(/on a sample pull request/)).toBeTruthy();
  cleanup();
  render(<WorkflowTab config={{ workflow: { ...WORKFLOW, sample: false } } as RepoConfig} />);
  expect(screen.getByText(/No policy was asked/)).toBeTruthy();
});

const decision = (partial: Partial<PolicyDecision>): PolicyDecision => ({
  decision: "fix",
  rule: "deny_fix",
  denied: false,
  messages: [],
  pr: 25,
  at: 1,
  ...partial,
});

test("withDecisions: a pull request's last real decision over the sample's, a grant's refusal kept", () => {
  const { workflow, real } = withDecisions(
    WORKFLOW,
    [
      // Newest first: the last review's decision allowed it.
      decision({ decision: "review", rule: "deny_review" }),
      decision({ decision: "review", rule: "deny_review", denied: true, messages: ["old"] }),
      decision({
        denied: true,
        messages: ["no CI fix on Fridays"],
        input: { reason: "ci" },
        layers: [
          {
            layer: "repo",
            allow: null,
            denies: ["no CI fix on Fridays"],
            allowFiles: [],
            denyFiles: ["f.rego"],
            error: null,
          },
        ],
      }),
      decision({ decision: "merge", rule: "allow_merge" }),
      // A fix decision whose input wasn't kept: which step it was about isn't known.
      decision({ denied: true, messages: ["an older CI fix's"] }),
      // Another pull request's.
      decision({ pr: 3, denied: true, messages: ["not this one"] }),
    ],
    25,
  );
  const state = (id: string) => workflow.nodes.find((n) => n.id === id)!;
  expect(state("review").state).toBe("on");
  expect(state("ci-fix")).toMatchObject({
    state: "refused",
    reasons: [{ message: "no CI fix on Fridays", layer: "repo" }],
  });
  // The fix itself: no decision kept, the sample's.
  expect(state("fix").state).toBe("on");
  // Refused by the grant: no policy decision lets it run.
  expect(state("merge").state).toBe("refused");
  expect([...real].sort()).toEqual(["ci-fix", "review"]);
});

test("a task's workflow: read once opened, its pull request's step highlighted", async () => {
  mockApi({ "api/repos/acme/app/config": () => ({ workflow: WORKFLOW }) });
  const task = makeTask({
    review: { loop: "fixing", round: 1, rounds: 3, ciFixes: 1, ciRounds: 2, history: [] },
  });
  render(<TaskWorkflow task={task} />);
  const fold = screen.getByText("Workflow").closest("details")!;
  fold.open = true;
  fireEvent(fold, new Event("toggle"));
  await waitFor(() => expect(screen.getAllByText("Here now")).toHaveLength(2));
  const fix = steps().getByText("Fix").closest("li")!;
  expect(fix.getAttribute("aria-current")).toBe("step");
  expect(loopCounters(task.review!)).toBe("Fix round 1/3 · CI fix 1/2");
  expect(loopCounters({ ...task.review!, rounds: 0, ciRounds: 0 })).toBe("1 CI fix");
});

test("layoutWorkflow: every arrow placed, the loops' going back under or beside the steps", () => {
  const layout = layoutWorkflow(WORKFLOW);
  expect(layout.edges).toHaveLength(WORKFLOW.edges.length);
  const at = (from: string, to: string) =>
    layout.edges.find((e) => e.from === from && e.to === to)!;
  // Straight down and back up one column, on either side.
  expect(at("ci", "ci-fix").d).toMatch(/^M\d+,\d+ V\d+$/);
  expect(at("ci-fix", "ci").d).toMatch(/^M\d+,\d+ V\d+$/);
  expect(at("ci", "ci-fix").d).not.toBe(at("ci-fix", "ci").d);
  // Over the top past the merge.
  expect(at("review", "done").d).toMatch(/^M\d+,\d+ V\d+ H\d+ V\d+$/);
  // Two over the top: the shorter one nearer the steps, so they don't cross.
  const top = (from: string) => Number(/ V(\d+) /.exec(at(from, "done").d)![1]);
  expect(top("review")).toBeGreaterThan(top("ci"));
  // A fix's push back to the CI step: under the grid, then up the gap before it.
  const back = at("fix", "ci").d;
  const under = Number(/V(\d+)/.exec(back)![1]);
  const bottom = Math.max(...layout.nodes.map((n) => n.y + NODE_H));
  expect(under).toBeGreaterThan(bottom);
  expect(layout.height).toBeGreaterThan(under);
  const empty: Workflow = { nodes: [], edges: [], sample: false };
  expect(layoutWorkflow(empty).edges).toEqual([]);
});
