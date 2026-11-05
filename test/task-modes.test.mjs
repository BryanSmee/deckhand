// Which mode a comment runs in, and the reply when its "/mode" line names none the repo has.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBrainstorms, createIssueModes } from "../listener/brainstorms.mjs";
import { createOnboardingStore } from "../listener/onboarding.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createTaskModes } from "../listener/task-modes.mjs";
import { grantedOf, tempDir, testConfig } from "./helpers.mjs";

const config = testConfig();

// modeOf() for a comment on org/repo#12 with the repo's `yaml`: what it ran, and the replies.
// `issueModes`: the issues' current modes, kept across calls. `sessions`: the volumes that hold an
// agent session (the runner's hasSession()). `grants`: what the operator's policies grant the repo
// (grants.mjs GRANTS), with policies that are Deckhand's alone otherwise; none: no policies.
// `brainstorms`, `onboarded`: brainstorms.mjs's and onboarding.mjs's, when a test follows them.
async function modeOf(
  fields,
  yaml = "",
  {
    cfg = config,
    issueModes = new Map(),
    reviews = null,
    decisions = null,
    posted,
    sessions = new Set(),
    grants = null,
    brainstorms = { get: () => null, end: () => {} },
    onboarded = null,
  } = {},
) {
  const replies = [];
  const ctx = {
    config: cfg,
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes,
    brainstorms,
    onboarded,
    // `posted`: GitHub's response to a reply, when a test reads it.
    reply: async (repo, number, text) => {
      replies.push([repo, number, text]);
      return posted;
    },
    reviews,
    decisions,
    runner: { hasSession: async (name, agent) => sessions.has(`${name}-${agent.session.volume}`) },
    ...(grants && {
      policies: {
        grants: async (repo) => grantedOf(grants.list)(repo),
        policiesFor: async () => ({ operator: new Map(), repo: new Map() }),
        deckhandOnly: () => true,
      },
    }),
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
      "Unknown mode `foo`. The modes here: `work`, `brainstorm`, `onboarding`, `research` (not granted here), `policy`. Pick one with a `/mode <name>` line.",
    ],
  ]);
  // The repo's own modes are listed too.
  const modes = "modes:\n  audit:\n    instructions: .deckhand/audit.md\n";
  const own = await modeOf({ trigger: "work", modeLine: "reveiw" }, modes);
  assert.equal(own.mode, null);
  assert.match(
    own.replies[0][2],
    /^Unknown mode `reveiw`\. The modes here: `work`, `brainstorm`, `onboarding`, `research` \(not granted here\), `policy`, `audit`\./,
  );
  assert.equal((await modeOf({ trigger: "work", modeLine: "audit" }, modes)).mode, "audit");
});

test("/mode research: refused without the operator's grant, naming it; no run, no mode kept", async () => {
  const issueModes = new Map();
  const { mode, replies } = await modeOf({ modeLine: "research" }, "", { issueModes });
  assert.equal(mode, null);
  assert.match(
    replies[0][2],
    /^Research can't run here: research runs need the `research` grant: the operator's policies don't grant `research` to this repository/,
  );
  assert.equal(issueModes.has("org/repo#12"), false);
});

test("/mode research with the grant: it starts alone, and comments go on in it", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "default.yaml"), "hosts: [pypi.org]\n");
  const cfg = testConfig({ GRANTS_DIR: dir });
  const issueModes = new Map();
  // The operator's policies grant it.
  const grants = { list: ["research"] };
  const first = await modeOf({ modeLine: "research" }, "", { cfg, issueModes, grants });
  assert.equal(first.mode, "research");
  assert.deepEqual(first.replies, []);
  assert.equal(issueModes.get("org/repo#12"), "research");
  // A comment without a trigger or /mode line: still research.
  assert.equal((await modeOf({}, "", { cfg, issueModes, grants })).mode, "research");
  // The grant gone meanwhile: refused, and the issue leaves the mode.
  grants.list = [];
  const after = await modeOf({}, "", { cfg, issueModes, grants });
  assert.equal(after.mode, null);
  assert.match(after.replies[0][2], /don't grant `research`/);
  assert.equal(issueModes.get("org/repo#12"), null);
  // A broken grants file: refused too, naming it.
  mkdirSync(join(dir, "org"));
  writeFileSync(join(dir, "org", "repo.yaml"), "hosts: [bad host]\n");
  grants.list = ["research"];
  const broken = await modeOf({ modeLine: "research" }, "", { cfg, issueModes, grants });
  assert.equal(broken.mode, null);
  assert.match(
    broken.replies[0][2],
    /`org\/repo\.yaml` in the operator's grants folder has errors/,
  );
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

test("/mode policy: a dry run replied on the pull request, no run; on an issue, refused", async () => {
  const asked = [];
  const reviews = {
    dryRun: async (what) => {
      asked.push(what);
      return { text: "**Policy dry run** on #30", denials: 0 };
    },
  };
  // Deckhand's own pull request #30, linked to issue #12, in a repo without a review block.
  const linked = await modeOf(
    { kind: "issue", replyTo: 30, base: "trunk", modeLine: "policy", author: "alice" },
    "",
    { reviews },
  );
  assert.equal(linked.mode, null);
  // Who asked: the run samples' sender.
  assert.deepEqual(asked, [{ repo: "org/repo", base: "trunk", number: 30, by: "alice" }]);
  assert.deepEqual(linked.replies, [["org/repo", 30, "**Policy dry run** on #30"]]);
  const pr = await modeOf({ kind: "pr", id: "pr-12", modeLine: "policy" }, "", { reviews });
  assert.deepEqual([pr.mode, pr.replies[0][2]], [null, "**Policy dry run** on #30"]);
  const issue = await modeOf({ kind: "issue", trigger: "work", modeLine: "policy" }, "", {
    reviews,
  });
  assert.equal(issue.mode, null);
  assert.equal(asked.length, 2);
  assert.match(
    issue.replies[0][2],
    /^A policy dry run is of a pull request: comment `\/mode policy`/,
  );
  // GitHub failing: said in the reply.
  const failing = {
    dryRun: async () => {
      throw new Error("GitHub said 502");
    },
  };
  const failed = await modeOf({ kind: "pr", id: "pr-12", modeLine: "policy" }, "", {
    reviews: failing,
  });
  assert.match(
    failed.replies[0][2],
    /^The policy dry run failed: GitHub couldn't be read \(GitHub said 502\)/,
  );
});

test("/mode policy: the dry run kept on the task, who asked, its denials and reply; never on a refusal", async () => {
  const kept = [];
  const decisions = { recordDryRun: (key, entry) => kept.push([key, entry]) };
  const reviews = { dryRun: async () => ({ text: "**Policy dry run** on #30", denials: 2 }) };
  const url = "https://github.com/org/repo/pull/30#issuecomment-9";
  const posted = Response.json({ html_url: url }, { status: 201 });
  await modeOf(
    { kind: "issue", replyTo: 30, base: "trunk", modeLine: "policy", author: "alice" },
    "",
    { reviews, decisions, posted },
  );
  assert.deepEqual(kept, [["org/repo#12", { by: "alice", url, denials: 2 }]]);
  // GitHub's response unreadable: kept without a link.
  await modeOf({ kind: "pr", id: "pr-12", modeLine: "policy" }, "", { reviews, decisions });
  assert.deepEqual(kept[1], ["org/repo#pr-12", { by: null, url: null, denials: 2 }]);
  // Refused on an issue, or failed: no dry run ran, nothing kept.
  await modeOf({ kind: "issue", trigger: "work", modeLine: "policy" }, "", { reviews, decisions });
  const failing = { dryRun: async () => Promise.reject(new Error("GitHub said 502")) };
  await modeOf({ kind: "pr", id: "pr-12", modeLine: "policy" }, "", {
    reviews: failing,
    decisions,
  });
  assert.equal(kept.length, 2);
});

test("a comment without a trigger line goes on with a session in any volume a work run may have had", async () => {
  // None: nothing to go on with.
  assert.equal((await modeOf({})).mode, null);
  // A work run without `pull` kept it in `-bare`, one without `push` in `-readonly`
  // (sandbox-spec.mjs sessionOf()): the comment goes on as work.
  for (const volume of ["claude", "bare-claude", "readonly-claude", "readonly-trusted-claude"]) {
    const sessions = new Set([`deckhand-org-repo-12-${volume}`]);
    assert.equal((await modeOf({}, "", { sessions })).mode, "work", volume);
  }
  // A light run's, whatever its capabilities gave it, isn't work's.
  for (const volume of ["light-claude", "light-trusted-claude", "light-bare-claude"]) {
    const sessions = new Set([`deckhand-org-repo-12-${volume}`]);
    assert.equal((await modeOf({}, "", { sessions })).mode, null, volume);
  }
});

// The issue's brainstorm as brainstorms.mjs keeps it, its idle timer under the test's clock.
function brainstormsOf(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  return createBrainstorms({ idleMs: 60000, busy: () => false, log: () => {}, now: Date.now });
}

test("/mode brainstorm discusses; a comment goes on in it; /stop wraps it up; the trigger then works", async (t) => {
  const brainstorms = brainstormsOf(t);
  const issueModes = createIssueModes();
  const opts = { brainstorms, issueModes };
  const key = "org/repo#12";
  // "@Deckhand /mode Brainstorm" (events.mjs splitTrigger()).
  const first = await modeOf({ trigger: "work", modeLine: "brainstorm" }, "", opts);
  assert.deepEqual([first.mode, first.replies], ["brainstorm", []]);
  assert.equal(brainstorms.get(key).status, "active");
  assert.equal(issueModes.has(key), false);
  // A comment without the trigger goes on in the brainstorm.
  assert.equal((await modeOf({}, "", opts)).mode, "brainstorm");
  // "/stop": its wrap-up, a brainstorm's run still.
  assert.equal((await modeOf({ trigger: "stop" }, "", opts)).mode, "stop");
  assert.equal(brainstorms.get(key).status, "stopped");
  // Stopped: a comment without a trigger line reaches nothing.
  assert.equal((await modeOf({}, "", opts)).mode, null);
  // The trigger alone implements: work, the brainstorm over.
  assert.equal((await modeOf({ trigger: "work" }, "", opts)).mode, "work");
  assert.equal(brainstorms.get(key), undefined);
});

test("/mode work alone moves a brainstorm to work; without one or a session, nothing", async (t) => {
  const brainstorms = brainstormsOf(t);
  const opts = { brainstorms, issueModes: createIssueModes() };
  assert.equal(
    (await modeOf({ trigger: "work", modeLine: "brainstorm" }, "", opts)).mode,
    "brainstorm",
  );
  assert.equal((await modeOf({ modeLine: "work" }, "", opts)).mode, "work");
  assert.equal(brainstorms.get("org/repo#12"), undefined);
  // Nothing to switch from now: no brainstorm, no mode, no session.
  assert.equal((await modeOf({ modeLine: "work" }, "", opts)).mode, null);
});

test("/mode onboarding alone on an issue: its conversation, the issue recorded as the repo's onboarding", async () => {
  const issueModes = createIssueModes();
  const onboarded = createOnboardingStore();
  const { mode, replies } = await modeOf({ modeLine: "onboarding" }, "", { issueModes, onboarded });
  assert.deepEqual([mode, replies], ["onboarding", []]);
  assert.equal(issueModes.get("org/repo#12"), "onboarding");
  assert.equal(onboarded.get("org/repo").issue, 12);
  // A comment without a trigger line goes on in it.
  assert.equal((await modeOf({}, "", { issueModes, onboarded })).mode, "onboarding");
});
