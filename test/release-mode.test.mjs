// This repository's release mode stays within Deckhand's unmodified operator ceiling.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { githubSamples, pushSample } from "../listener/reviews.mjs";
import { refusal } from "../listener/git-gateway.mjs";
import { defaultPolicies, hasOpa, testConfig } from "./helpers.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const repo = { "mode-release.rego": read(".deckhand/policy/mode-release.rego") };
const config = () =>
  parseRepoConfig(read(".deckhand.yaml"), testConfig({ AUTO_PICKUP_SLOTS: "1" }));
const release = {
  repo: "bryansmee/deckhand",
  mode: "release",
  custom_mode: true,
  reason: null,
  issue: 12,
};

test("release mode: the repository config selects its instructions and Claude Opus", () => {
  const { settings, errors, warnings } = config();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(settings.modes.release.agent, "claude");
  assert.equal(settings.modes.release.model, settings.review.model);
  assert.ok(read(settings.modes.release.instructions).length > 0);
});

test(
  "release mode: policy dry run with both layers",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const policies = defaultPolicies(t, { repo });
    assert.deepEqual(await policies.check(new Map(Object.entries(repo)), "repo"), {
      errors: [],
      warnings: [],
    });
    const deny = (decision, input) =>
      policies.deny(`deny_${decision}`, release.repo, "main", () => ({ ...release, ...input }));
    for (const kind of ["issue", "pr", "discussion"]) {
      const result = await deny("run", { target: { kind } });
      assert.equal(result.length === 0, kind === "issue", kind);
    }

    const { results, error } = await policies.capabilityRules(release.repo, "main", {
      release: { ...release, repo: { name: release.repo, private: false } },
    });
    assert.equal(error, undefined);
    const caps = [...results.release.repo.allow.keys()].sort();
    assert.deepEqual(caps, ["pull", "push", "read:actions", "read:issues", "read:pulls", "setup"]);
    for (const cap of caps) assert.ok(results.release.operator.allow.has(cap), cap);

    const allowed = {
      own_issue: ["edit", "link"],
      own_pr: ["edit", "draft", "milestone"],
      new_pr: ["create", "milestone"],
      new_issue: ["create", "milestone"],
      created_issue: ["edit", "link", "milestone"],
      sub_issue: ["link"],
    };
    for (const [kind, actions] of Object.entries(allowed)) {
      for (const action of actions) {
        assert.deepEqual(
          await deny("github", {
            action,
            actions: [action],
            target: { kind },
            change: { fields: ["body"] },
          }),
          [],
          `${kind}: ${action}`,
        );
      }
    }
    for (const [kind, actions] of [
      ["own_pr", ["ready", "merge", "close", "assign", "comment", "update_branch"]],
      ["own_issue", ["close", "label", "milestone"]],
      ["other_issue", ["edit", "link"]],
      ["pr", ["edit", "draft"]],
      ["release", ["create"]],
      ["tag", ["create"]],
    ]) {
      for (const action of actions) {
        assert.ok(
          (
            await deny("github", {
              action,
              actions: [action],
              target: { kind },
            })
          ).length,
          `${kind}: ${action}`,
        );
      }
    }
    assert.ok(
      (
        await deny("github", {
          action: "edit",
          actions: ["edit", "close"],
          target: { kind: "own_issue" },
        })
      ).length,
    );
    assert.deepEqual(await deny("github", { action: "read_checks", actions: ["read_checks"] }), []);

    // The same sample builders /mode policy uses, plus release-specific push refusals.
    const pr = { number: 20, head: { ref: "issue-12-release-v0-2-0" }, base: { ref: "main" } };
    for (const { input } of githubSamples(release.repo, pr, config().settings.modes)) {
      const denied = await deny("github", input);
      assert.equal(denied.length > 0, ["release", "brainstorm"].includes(input.mode));
    }
    const { input: push } = pushSample(release.repo, pr, { number: 12 }, "main");
    const ownPush = { ...push, ...release };
    assert.deepEqual(await deny("push", ownPush), []);
    for (const input of [
      { ...ownPush, branch: "main", ref: "refs/heads/main" },
      { ...ownPush, branch: "issue-13-release", ref: "refs/heads/issue-13-release" },
      { ...ownPush, ref: "refs/tags/v0.2.0" },
      { ...ownPush, deleted: true },
      { ...ownPush, mode: "unknown" },
    ])
      assert.ok((await deny("push", input)).length, JSON.stringify(input));

    // The gateway refuses these before asking any policy, even an operator's allow-all.
    for (const ref of ["refs/tags/v0.2.0", "refs/heads/main", "refs/heads/issue-13-release"]) {
      assert.ok(refusal(ref, "main", ["issue-12-*"]), ref);
    }
    // Adding a repo policy must not take permissions away from ordinary work runs.
    assert.deepEqual(
      await deny("github", {
        mode: "work",
        custom_mode: false,
        action: "ready",
        actions: ["ready"],
        target: { kind: "own_pr" },
      }),
      [],
    );
  },
);
