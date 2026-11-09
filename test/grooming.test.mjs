// A grooming (#585): what Deckhand's mode-grooming.rego lets its runs write, with the real opa,
// and the close's reason (`change.state_reason`) its wrap-up is held to, over REST and GraphQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGraphqlChecks } from "../listener/github-graphql.mjs";
import { classify } from "../listener/github-writes.mjs";
import { defaultPolicies, hasOpa } from "./helpers.mjs";

const withOpa = { skip: !hasOpa() && "no opa on the PATH" };
const json = (value) => Buffer.from(JSON.stringify(value));

// A write's input for the policies (github-writes.mjs deny()), for a run in `mode` on issue #1.
function writeInput(mode, actions, kind, change = {}) {
  return {
    repo: "org/repo",
    mode,
    custom_mode: false,
    reason: null,
    issue: 1,
    action: actions[0],
    actions,
    target: {
      kind,
      number: kind.startsWith("new_") || kind === "label" ? null : 5,
      labels: [],
      author: "bob",
    },
    change: { fields: [], labels_added: [], labels_removed: [], ...change },
  };
}

test("a close's reason, as GitHub reads it: `completed` without one, REST's and GraphQL's alike", async () => {
  const patch = (body) =>
    classify("PATCH", "repos/org/repo/issues/5", json(body)).change.state_reason;
  assert.equal(patch({ state: "closed", state_reason: "not_planned" }), "not_planned");
  assert.equal(patch({ state: "closed", state_reason: "duplicate" }), "duplicate");
  assert.equal(patch({ state: "closed" }), "completed");
  assert.equal(patch({ state: "open" }), undefined);
  assert.equal(patch({ title: "x" }), undefined);
  // Labels set with it still replace the issue's.
  const both = classify(
    "PATCH",
    "repos/org/repo/issues/5",
    json({ state: "closed", state_reason: "not_planned", labels: ["a"] }),
  );
  assert.deepEqual(both.actions, ["close", "label"]);
  assert.deepEqual(both.change.labels_added, ["a"]);
  assert.equal(both.change.labels_set, true);

  const writes = [];
  const { check } = createGraphqlChecks({
    nodes: async (_repo, ids) =>
      ids.map((id) => ({
        __typename: "Issue",
        number: Number(id.slice(2)),
        repository: { nameWithOwner: "org/repo" },
      })),
    checkWrite: async (_run, write) => (writes.push(write), null),
  });
  const run = { repo: "org/repo", mode: "grooming-stop", issue: 1, base: "main", created: [] };
  const close = (reason) =>
    `mutation { closeIssue(input: { issueId: "I_5"${reason ? `, stateReason: ${reason}` : ""} }) { clientMutationId } }`;
  for (const [reason, said] of [
    ["NOT_PLANNED", "not_planned"],
    ["DUPLICATE", "duplicate"],
    [null, "completed"],
  ]) {
    const out = await check(run, json({ query: close(reason) }));
    assert.equal(out.refused, undefined, out.refused?.message);
    assert.equal(writes.at(-1).change.state_reason, said, reason);
  }
  // `gh issue close --duplicate-of` names the other issue: a field Deckhand doesn't check.
  const duplicateOf =
    'mutation { closeIssue(input: { issueId: "I_5", stateReason: DUPLICATE, duplicateIssueId: "I_6" }) { clientMutationId } }';
  assert.ok((await check(run, json({ query: duplicateOf }))).refused);
  // An update that closes: completed, as GitHub reads it.
  const update =
    'mutation { updateIssue(input: { id: "I_5", state: CLOSED }) { clientMutationId } }';
  await check(run, json({ query: update }));
  assert.equal(writes.at(-1).change.state_reason, "completed");
});

test(
  "the real opa: mode-grooming.rego comments on other issues; its wrap-up edits, labels and closes them",
  withOpa,
  async (t) => {
    const policies = defaultPolicies(t);
    const ask = (mode, actions, kind, change) =>
      policies.deny("deny_github", "org/repo", "main", () =>
        writeInput(mode, actions, kind, change),
      );
    const none = (action, kind, mode) => [
      `no rule allows \`${action}\` on \`${kind}\` for a \`${mode}\` run`,
    ];
    const others = ["other_issue", "sub_issue", "created_issue"];
    for (const mode of ["grooming", "grooming-stop"]) {
      // Its own issue, the issues and labels it files: as a brainstorm.
      for (const action of ["edit", "link", "react", "unreact"]) {
        assert.deepEqual(await ask(mode, [action], "own_issue"), [], `${mode}: ${action}`);
      }
      assert.deepEqual(await ask(mode, ["create", "milestone"], "new_issue"), [], mode);
      assert.deepEqual(await ask(mode, ["create"], "label", { labels_added: ["x"] }), [], mode);
      // Never a comment on its own issue: its final message is the reply.
      assert.deepEqual(await ask(mode, ["comment"], "own_issue"), [
        "a grooming doesn't comment on its own issue: its final message is posted as its reply",
      ]);
      // It comments on the issues it reviews.
      for (const kind of others) assert.deepEqual(await ask(mode, ["comment"], kind), [], kind);
      // No pull request, its own or another, nor a new one.
      for (const [action, kind, change] of [
        ["create", "new_pr"],
        ["comment", "pr"],
        ["edit", "pr"],
        ["comment", "own_pr"],
        ["close", "pr", { state_reason: "not_planned" }],
      ]) {
        assert.deepEqual(await ask(mode, [action], kind, change), none(action, kind, mode), action);
      }
      // Nothing it may never do: assign, lock, reopen, delete.
      for (const action of ["assign", "lock", "reopen", "delete"]) {
        assert.ok((await ask(mode, [action], "other_issue")).length, `${mode}: ${action}`);
      }
    }
    // While it goes on, nothing but comments on other issues.
    for (const kind of others) {
      for (const action of ["edit", "label", "close"]) {
        const change = action === "close" ? { state_reason: "not_planned" } : {};
        assert.deepEqual(
          await ask("grooming", [action], kind, change),
          none(action, kind, "grooming"),
          `${action} on ${kind}`,
        );
      }
    }
    // The wrap-up edits, labels and closes them, as not planned or as a duplicate only.
    for (const kind of others) {
      assert.deepEqual(await ask("grooming-stop", ["edit"], kind), [], kind);
      assert.deepEqual(
        await ask("grooming-stop", ["label"], kind, { labels_added: ["stale"] }),
        [],
        kind,
      );
      for (const state_reason of ["not_planned", "duplicate"]) {
        assert.deepEqual(await ask("grooming-stop", ["close"], kind, { state_reason }), [], kind);
      }
      assert.deepEqual(
        await ask("grooming-stop", ["close", "label", "edit"], kind, {
          state_reason: "duplicate",
        }),
        [],
        kind,
      );
    }
    for (const change of [{ state_reason: "completed" }, {}]) {
      assert.deepEqual(await ask("grooming-stop", ["close"], "other_issue", change), [
        "a grooming closes an issue as not planned or as a duplicate only",
      ]);
    }
  },
);

test(
  "the real opa: a brainstorm's /stop keeps its own rights, which mode-grooming.rego leaves alone",
  withOpa,
  async (t) => {
    const policies = defaultPolicies(t);
    const ask = (mode, actions, kind, change) =>
      policies.deny("deny_github", "org/repo", "main", () =>
        writeInput(mode, actions, kind, change),
      );
    for (const mode of ["brainstorm", "stop"]) {
      assert.deepEqual(await ask(mode, ["comment"], "other_issue"), [
        "a brainstorm doesn't comment: its final message is posted as its reply",
      ]);
      for (const action of ["edit", "label", "close"]) {
        const change = { state_reason: "not_planned" };
        assert.deepEqual(await ask(mode, [action], "other_issue", change), [
          `no rule allows \`${action}\` on \`other_issue\` for a \`${mode}\` run`,
        ]);
      }
      assert.deepEqual(await ask(mode, ["edit"], "own_issue"), []);
    }
  },
);

test(
  "the real opa: a grooming gets a brainstorm's capabilities and pushes nowhere",
  withOpa,
  async (t) => {
    const policies = defaultPolicies(t);
    for (const mode of ["grooming", "grooming-stop"]) {
      const push = await policies.deny("deny_push", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        custom_mode: false,
        reason: null,
        issue: 1,
        action: "push",
        branch: "issue-1-x",
        ref: "refs/heads/issue-1-x",
        created: true,
        deleted: false,
        default_branch: "main",
      }));
      assert.ok(push.length, mode);
    }
  },
);
