import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { pullRequest } from "../listener/events.mjs";
import { createPulls } from "../listener/pulls.mjs";

const config = loadConfig({ ALLOWED_USERS: "alice", ALLOWED_REPOS: "org/repo" });
const NOW = 1_800_000_000_000;

function delivery(action, pr, { repo = "Org/Repo", installation = 7 } = {}) {
  return {
    action,
    installation: installation && { id: installation },
    repository: { full_name: repo, default_branch: "main" },
    pull_request: {
      number: 31,
      html_url: `https://github.com/${repo}/pull/31`,
      body: "Closes #30",
      state: "open",
      draft: true,
      merged: false,
      head: { ref: "issue-30-fix", repo: { full_name: repo } },
      ...pr,
    },
  };
}

const map = (action, pr, opts) =>
  pullRequest(config, "pull_request", delivery(action, pr, opts), NOW);

test("pull_request deliveries: the linked issue's task, else the pull request's", () => {
  assert.deepEqual(map("opened"), {
    key: "Org/Repo#30",
    pr: { number: 31, url: "https://github.com/Org/Repo/pull/31", state: "draft", readyAt: null },
  });
  assert.equal(map("opened", { body: "A fix" }).key, "Org/Repo#pr-31");
  assert.equal(map("opened", { body: null }).key, "Org/Repo#pr-31");
  // A fork's (or one whose fork is gone) is its own task, whatever it says it closes.
  const fork = { head: { ref: "issue-30-fix", repo: { full_name: "mallory/repo" } } };
  assert.equal(map("opened", fork).key, "Org/Repo#pr-31");
  assert.equal(map("opened", { head: { ref: "x", repo: null } }).key, "Org/Repo#pr-31");
});

test("pull_request states: ready, draft again, merged or closed", () => {
  assert.equal(map("ready_for_review", { draft: false }).pr.state, "ready");
  assert.equal(map("ready_for_review", { draft: false }).pr.readyAt, NOW);
  // Opened ready for review: ready at once.
  assert.equal(map("opened", { draft: false }).pr.readyAt, NOW);
  assert.equal(map("reopened", { draft: false }).pr.readyAt, NOW);
  assert.equal(map("converted_to_draft").pr.state, "draft");
  // An edit doesn't make it newly ready.
  assert.equal(map("edited", { draft: false }).pr.readyAt, null);
  assert.equal(map("closed", { state: "closed", merged: true }).pr.state, "merged");
  assert.equal(map("closed", { state: "closed", merged: false }).pr.state, "closed");
});

test("pull_request deliveries outside the allowlist, the App or the actions are ignored", () => {
  assert.equal(map("opened", {}, { repo: "Org/Other" }), null);
  assert.equal(map("opened", {}, { installation: null }), null);
  assert.equal(map("synchronize"), null);
  assert.equal(map("labeled"), null);
  assert.equal(pullRequest(config, "issue_comment", delivery("opened"), NOW), null);
});

const tempPath = () => join(mkdtempSync(join(tmpdir(), "deckhand-")), "pulls.json");
const pr = (number, state, readyAt = null) => ({
  number,
  url: `https://github.com/org/repo/pull/${number}`,
  state,
  readyAt,
});

test("pulls: recorded per task, and kept across a restart", () => {
  const path = tempPath();
  const pulls = createPulls({ path, listPulls: async () => [] });
  pulls.record("org/repo#30", pr(31, "draft"));
  pulls.record("org/repo#30", pr(31, "ready", NOW));
  assert.deepEqual(pulls.get("org/repo#30"), pr(31, "ready", NOW));
  // Merged: when it turned ready stays.
  pulls.record("org/repo#30", pr(31, "merged"));
  assert.deepEqual(pulls.get("org/repo#30"), pr(31, "merged", NOW));
  assert.equal(pulls.get("org/repo#29"), null);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))["org/repo#30"], pr(31, "merged", NOW));
  const next = createPulls({ path, listPulls: async () => [] });
  assert.deepEqual(next.get("org/repo#30"), pr(31, "merged", NOW));
});

test("pulls: an edited link moves the pull request; a closed one doesn't hide an open one", () => {
  const pulls = createPulls({ path: tempPath(), listPulls: async () => [] });
  pulls.record("org/repo#pr-31", pr(31, "ready", NOW));
  // "Closes #30" added to its description.
  pulls.record("org/repo#30", pr(31, "ready"));
  assert.equal(pulls.get("org/repo#pr-31"), null);
  assert.deepEqual(pulls.get("org/repo#30"), pr(31, "ready", NOW));

  // A second attempt, then the first one closed.
  pulls.record("org/repo#30", pr(32, "draft"));
  assert.equal(pulls.record("org/repo#30", pr(31, "closed")), false);
  assert.equal(pulls.get("org/repo#30").number, 32);
  // A merged one replaces a closed one.
  pulls.record("org/repo#30", pr(32, "closed"));
  pulls.record("org/repo#30", pr(33, "merged"));
  assert.equal(pulls.get("org/repo#30").number, 33);
});

test("pulls: older tasks looked up once per repo, by branch, link or number", async () => {
  const asked = [];
  const listPulls = async (repo) => {
    asked.push(repo);
    if (repo === "org/broken") throw new Error("Not Found");
    return [
      {
        number: 9,
        html_url: "u9",
        body: "Closes #4",
        state: "open",
        draft: false,
        head: { ref: "x", repo: { full_name: "org/repo" } },
      },
      {
        number: 8,
        html_url: "u8",
        body: "",
        state: "closed",
        merged_at: "2026-01-01",
        head: { ref: "issue-5-fix", repo: { full_name: "org/repo" } },
      },
      // A fork's: neither its branch nor its link count.
      {
        number: 10,
        html_url: "u10",
        body: "Closes #6",
        state: "open",
        head: { ref: "issue-6-x", repo: { full_name: "mallory/repo" } },
      },
      { number: 7, html_url: "u7", body: "", state: "closed", merged_at: null, head: { ref: "y" } },
    ];
  };
  const pulls = createPulls({ path: tempPath(), listPulls });
  pulls.record("org/repo#1", pr(2, "draft"));
  const keys = [
    "org/repo#1",
    "org/repo#4",
    "org/repo#5",
    "org/repo#pr-7",
    "org/repo#6",
    "org/repo#discussion-3",
    "org/broken#1",
  ];
  await pulls.fill(keys);
  assert.deepEqual(asked, ["org/repo", "org/broken"]);
  assert.deepEqual(pulls.get("org/repo#1"), pr(2, "draft"));
  assert.deepEqual(pulls.get("org/repo#4"), {
    number: 9,
    url: "u9",
    state: "ready",
    readyAt: null,
  });
  assert.equal(pulls.get("org/repo#5").state, "merged");
  assert.equal(pulls.get("org/repo#pr-7").state, "closed");
  assert.equal(pulls.get("org/repo#6"), null);
  // Not asked again by this listener.
  await pulls.fill([...keys, "org/repo#10"]);
  assert.equal(asked.length, 2);
});
