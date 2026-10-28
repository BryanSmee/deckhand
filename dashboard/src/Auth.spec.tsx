// The Claude credential a run used (listener/agents/select.mjs authOf()): a tag by its model,
// in the run's outcome and on a discussion's page, so the operator sees which runs the API key
// billed. Nothing for runs off Anthropic.
import { render, screen, within } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Dashboard } from "./App";
import { Outcome } from "./Outcome";
import { makeState, makeTask, mockApi } from "./testUtils";
import type { Run, Task } from "./types";

const run = (partial: Partial<Run> = {}): Run => ({
  id: "acme-app-5-1",
  key: "acme/app#5",
  kind: "issue",
  title: null,
  repo: "acme/app",
  replyTo: 5,
  mode: "start",
  taskMode: "work",
  model: "opus",
  effort: "high",
  startedAt: 1791882000000,
  finishedAt: 1791882720000,
  status: "ok",
  summary: "Done.",
  ...partial,
});

const show = (task: Task) => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent(task.key)}`);
  render(<Dashboard state={makeState({}, [task])} error={null} refresh={async () => {}} />);
};

const outcome = () => within(screen.getByRole("region", { name: "Outcome" }));

test("a run on the plan says Plan by its model, naming the variable", () => {
  show(
    makeTask({ number: 5, state: "done", runs: [run({ provider: "anthropic", auth: "plan" })] }),
  );
  const tag = outcome().getByText("Plan");
  expect(tag.getAttribute("title")).toBe("Ran on CLAUDE_CODE_OAUTH_TOKEN");
  // One more fact chip like the duration's, not a status pill.
  expect(tag.className).toMatch(/fact/);
  expect(tag.className).not.toMatch(/badge|outline/);
  expect(outcome().getByText(/opus/).className).toBe(tag.className);
});

test("on a phone, the tag is plain text in the facts line", () => {
  const r = run({ provider: "anthropic", auth: "plan" });
  render(
    <Outcome
      task={makeTask({ number: 5, state: "done", runs: [r] })}
      run={r}
      now={r.finishedAt!}
      github="https://github.com"
      touch
    />,
  );
  const tag = outcome().getByText("Plan");
  expect(tag.className).toBe("");
  expect(tag.parentElement!.textContent).toBe(" · Plan");
});

test("a run on the API key, or through a gateway, says so", () => {
  show(makeTask({ number: 5, state: "done", runs: [run({ provider: "anthropic", auth: "key" })] }));
  expect(outcome().getByText("API key").getAttribute("title")).toBe("Ran on ANTHROPIC_API_KEY");
});

test("a run off Anthropic, or from before the field: no tag", () => {
  show(
    makeTask({
      number: 5,
      state: "done",
      runs: [run({ agent: "codex", provider: "openai", auth: null, model: "gpt-5" })],
    }),
  );
  expect(outcome().getByText(/gpt-5/)).toBeTruthy();
  for (const label of ["Plan", "API key", "Gateway"]) {
    expect(outcome().queryByText(label)).toBeNull();
  }
});

test("a discussion's page: the tag next to the model", async () => {
  const post = { id: "D_8", url: "u", author: "alice", deckhand: false, at: null, body: "Hi" };
  mockApi({
    "api/repos/acme/app/discussions/31": () => ({
      number: 31,
      title: "Digest?",
      url: "u",
      post,
      comments: [],
      more: 0,
      readAt: 0,
    }),
  });
  show(
    makeTask({
      key: "acme/app#discussion-31",
      repo: "acme/app",
      number: 31,
      kind: "discussion",
      state: "done",
      runs: [
        run({
          key: "acme/app#discussion-31",
          kind: "discussion",
          provider: "anthropic",
          auth: "gateway",
        }),
      ],
    }),
  );
  const tag = await screen.findByText("Gateway");
  expect(tag.getAttribute("title")).toBe("Ran on ANTHROPIC_AUTH_TOKEN");
  // Plain text after the model, like its effort.
  expect(tag.parentElement!.textContent).toBe("opus · high effort · Gateway");
});
