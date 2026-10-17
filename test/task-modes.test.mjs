// Which mode a comment runs in, and the reply when its "/mode" line names none the repo has.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createTaskModes } from "../listener/task-modes.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const config = testConfig();

// modeOf() for a comment on org/repo#12 with the repo's `yaml`: what it ran, and the replies.
// `issueModes`: the issues' current modes, kept across calls.
async function modeOf(fields, yaml = "", { cfg = config, issueModes = new Map() } = {}) {
  const replies = [];
  const ctx = {
    config: cfg,
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes,
    brainstorms: { get: () => null, end: () => {} },
    reply: async (repo, number, text) => replies.push([repo, number, text]),
  };
  const { settings } = parseRepoConfig(yaml, config);
  const item = { repo: "org/repo", id: "12", number: 12, replyTo: 12, settings, ...fields };
  const { modeOf } = createTaskModes(ctx);
  return { mode: await modeOf(item, "org/repo#12", "deckhand-org-repo-12"), replies };
}

test("/mode with a name the repo doesn't have: a reply listing its modes, no run", async () => {
  const { mode, replies } = await modeOf({ trigger: "work", modeLine: "foo" });
  assert.equal(mode, null);
  assert.deepEqual(replies, [
    [
      "org/repo",
      12,
      "Unknown mode `foo`. The modes here: `work`, `brainstorm`, `onboarding`, `research` (not granted here). Pick one with a `/mode <name>` line.",
    ],
  ]);
  // The repo's own modes are listed too, a light one as comments only.
  const modes = "modes:\n  audit:\n    instructions: .deckhand/audit.md\n    light: true\n";
  const own = await modeOf({ trigger: "work", modeLine: "reveiw" }, modes);
  assert.equal(own.mode, null);
  assert.match(
    own.replies[0][2],
    /^Unknown mode `reveiw`\. The modes here: `work`, `brainstorm`, `onboarding`, `research` \(not granted here\), `audit` \(comments only\)\./,
  );
  assert.equal((await modeOf({ trigger: "work", modeLine: "audit" }, modes)).mode, "audit");
});

test("/mode research: refused without the operator's grant, naming it; no run, no mode kept", async () => {
  const issueModes = new Map();
  const { mode, replies } = await modeOf({ modeLine: "research" }, "", { issueModes });
  assert.equal(mode, null);
  assert.match(
    replies[0][2],
    /^Research can't run here: research runs need the operator's `allow_research: true` grant/,
  );
  assert.equal(issueModes.has("org/repo#12"), false);
});

test("/mode research with the grant: it starts alone, and comments go on in it", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "default.yaml"), "allow_research: true\n");
  const cfg = testConfig({ GRANTS_DIR: dir });
  const issueModes = new Map();
  const first = await modeOf({ modeLine: "research" }, "", { cfg, issueModes });
  assert.equal(first.mode, "research");
  assert.deepEqual(first.replies, []);
  assert.equal(issueModes.get("org/repo#12"), "research");
  // A comment without a trigger or /mode line: still research.
  assert.equal((await modeOf({}, "", { cfg, issueModes })).mode, "research");
  // The grant gone meanwhile: refused, and the issue leaves the mode.
  mkdirSync(join(dir, "org"));
  writeFileSync(join(dir, "org", "repo.yaml"), "allow_research: false\n");
  const after = await modeOf({}, "", { cfg, issueModes });
  assert.equal(after.mode, null);
  assert.match(after.replies[0][2], /allow_research/);
  assert.equal(issueModes.get("org/repo#12"), null);
});

test("/mode review: only with the repo's review block, and only on a pull request", async () => {
  // Without the block: an unknown mode, nothing runs.
  const off = await modeOf({ kind: "pr", id: "pr-12", trigger: "work", modeLine: "review" });
  assert.equal(off.mode, null);
  assert.match(off.replies[0][2], /^Unknown mode `review`\. The modes here: `work`, `brainstorm`/);
  // With it, on a pull request (its own task, or the issue's it closes), even without a
  // trigger line or a session: it starts its own.
  const on = "review:\n  on: manual\n";
  const pr = await modeOf({ kind: "pr", id: "pr-12", modeLine: "review" }, on);
  assert.deepEqual([pr.mode, pr.replies], ["review", []]);
  const linked = await modeOf({ kind: "issue", replyTo: 30, modeLine: "review" }, on);
  assert.equal(linked.mode, "review");
  // On an issue: refused, with a reply saying where to ask.
  const issueModes = new Map();
  const issue = await modeOf({ kind: "issue", trigger: "work", modeLine: "review" }, on, {
    issueModes,
  });
  assert.equal(issue.mode, null);
  assert.match(issue.replies[0][2], /^A review is of a pull request: comment `\/mode review` on/);
  // A fresh mode: the issue's own mode is untouched.
  assert.equal(issueModes.has("org/repo#12"), false);
  // An automatic one (reviews.mjs) is its own trigger.
  assert.equal((await modeOf({ kind: "pr", trigger: "review" }, on)).mode, "review");
});
