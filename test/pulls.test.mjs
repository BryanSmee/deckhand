import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pullRequest, replayedPull } from "../listener/events.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const config = testConfig({ ALLOWED_REPOS: "org/repo" });
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

test("pull_request deliveries: its size and commit count when GitHub sends them, a push's too", () => {
  const size = { additions: 86, deletions: 19, changed_files: 4, commits: 3 };
  const sized = { additions: 86, deletions: 19, changedFiles: 4, commits: 3 };
  assert.deepEqual(map("opened", size).pr, {
    number: 31,
    url: "https://github.com/Org/Repo/pull/31",
    state: "draft",
    readyAt: null,
    ...sized,
  });
  // A push to its branch changes them.
  assert.deepEqual(map("synchronize", { ...size, commits: 4 }).pr, {
    ...map("opened").pr,
    ...sized,
    commits: 4,
  });
  // Only numbers: a payload without them (or with junk) has none.
  assert.deepEqual(Object.keys(map("opened", { additions: "86", commits: null }).pr), [
    "number",
    "url",
    "state",
    "readyAt",
  ]);
});

test("pull_request deliveries outside the allowlist, the App or the actions are ignored", () => {
  assert.equal(map("opened", {}, { repo: "Org/Other" }), null);
  assert.equal(map("opened", {}, { installation: null }), null);
  assert.equal(map("labeled"), null);
  assert.equal(pullRequest(config, "issue_comment", delivery("opened"), NOW), null);
});

const tempPath = (t) => join(tempDir(t), "pulls.json");
const pr = (number, state, readyAt = null) => ({
  number,
  url: `https://github.com/org/repo/pull/${number}`,
  state,
  readyAt,
});

test("pulls: recorded per task, and kept across a restart", (t) => {
  const path = tempPath(t);
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

test("pulls: an edited link moves the pull request; a closed one doesn't hide an open one", (t) => {
  const pulls = createPulls({ path: tempPath(t), listPulls: async () => [] });
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

test("pulls: the same pull request under another spelling of the repo leaves it", (t) => {
  const pulls = createPulls({ path: tempPath(t), listPulls: async () => [] });
  // From a dashboard address before #287, then a webhook under GitHub's spelling.
  pulls.record("storywake/storywake#5", pr(6, "ready", NOW));
  pulls.record("Storywake/storywake#5", pr(6, "ready"));
  assert.deepEqual(pulls.keys(), ["Storywake/storywake#5"]);
  assert.deepEqual(pulls.get("Storywake/storywake#5"), pr(6, "ready", NOW));
  // Another repo's pull request with the same number stays.
  pulls.record("storywake/other#5", pr(6, "draft"));
  assert.equal(pulls.keys().length, 2);
});

test("pulls: fill() doesn't look up a task that has its pull request under another spelling", async (t) => {
  const asked = [];
  const listPulls = async (repo) => {
    asked.push(repo);
    return [
      {
        number: 6,
        html_url: "u",
        draft: true,
        state: "open",
        head: { ref: "issue-5-x", repo: { full_name: repo } },
      },
    ];
  };
  const pulls = createPulls({ path: tempPath(t), listPulls });
  pulls.record("storywake/storywake#5", pr(6, "draft"));
  await pulls.fill(["Storywake/storywake#5"]);
  assert.deepEqual(asked, []);
  assert.deepEqual(pulls.keys(), ["storywake/storywake#5"]);
});

test("pulls: respelled, both spellings of one pull request merged, the open one of two kept", (t) => {
  const path = tempPath(t);
  writeFileSync(
    path,
    JSON.stringify({
      "org/repo#30": { ...pr(31, "merged", NOW), autoMerged: true },
      "Org/repo#30": pr(31, "merged"),
      "org/repo#40": pr(41, "draft"),
      "Org/repo#40": pr(42, "closed"),
      "org/repo#50": pr(51, "draft"),
    }),
  );
  const pulls = createPulls({ path, listPulls: async () => [] });
  pulls.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "Org/repo#30": { ...pr(31, "merged", NOW), autoMerged: true },
    "Org/repo#40": pr(41, "draft"),
    "Org/repo#50": pr(51, "draft"),
  });
});

test("pulls: older tasks looked up once per repo, by branch, link or number", async (t) => {
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
  const pulls = createPulls({ path: tempPath(t), listPulls });
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

test("pulls: fill() asks once for the size of one found in a listing, merged or closed too", async (t) => {
  const path = tempPath(t);
  const listPulls = async () => [
    {
      number: 9,
      html_url: "u9",
      state: "closed",
      merged_at: "2026-10-21",
      head: { ref: "issue-4-x", repo: { full_name: "org/repo" } },
    },
  ];
  const fetched = [];
  const getPull = async (repo, number) => {
    fetched.push(`${repo}#${number}`);
    if (number === 3) return null; // gone
    return {
      number,
      state: "closed",
      merged_at: "2026-10-21",
      additions: 86,
      deletions: 19,
      changed_files: 4,
      commits: 3,
    };
  };
  const pulls = createPulls({ path, listPulls, getPull });
  // Recorded before sizes were, and gone from GitHub since.
  pulls.record("org/repo#2", pr(3, "closed"));
  await pulls.fill(["org/repo#4", "org/repo#2"]);
  assert.deepEqual(pulls.get("org/repo#4"), {
    number: 9,
    url: "u9",
    state: "merged",
    readyAt: null,
    additions: 86,
    deletions: 19,
    changedFiles: 4,
    commits: 3,
  });
  assert.deepEqual(pulls.get("org/repo#2"), pr(3, "closed"));
  assert.deepEqual(fetched.sort(), ["org/repo#3", "org/repo#9"]);
  // Not asked again on the next poll, even for the one GitHub couldn't size; kept on disk.
  assert.equal(await pulls.fill(["org/repo#4", "org/repo#2"]), null);
  assert.equal(fetched.length, 2);
  assert.equal(createPulls({ path, listPulls, getPull }).get("org/repo#4").commits, 3);
});

test("pulls: the open ones, for the conflict watcher", (t) => {
  const pulls = createPulls({ path: tempPath(t), listPulls: async () => [] });
  pulls.record("org/repo#30", pr(31, "draft"));
  pulls.record("org/repo#32", pr(33, "ready", NOW));
  pulls.record("org/repo#34", pr(35, "merged"));
  pulls.record("org/repo#pr-36", pr(36, "closed"));
  assert.deepEqual(
    pulls.open().map(([key]) => key),
    ["org/repo#30", "org/repo#32"],
  );
});

test("pulls: resync asks GitHub about the open ones again, so a lost delivery is caught up", async (t) => {
  const path = tempPath(t);
  const listed = [];
  const fetched = [];
  const listPulls = async (repo) => {
    listed.push(repo);
    if (repo === "org/broken") throw new Error("Not Found");
    return [
      { number: 31, html_url: "u31", state: "open", draft: false },
      { number: 33, html_url: "u33", state: "closed", merged_at: "2026-10-21" },
    ];
  };
  // Not in the recent list: asked one by one.
  const getPull = async (repo, number) => {
    fetched.push(`${repo}#${number}`);
    return { number, html_url: `u${number}`, state: "closed", merged: false };
  };
  const pulls = createPulls({ path, listPulls, getPull });
  // Their size known: the listing is enough for those it has.
  const sized = (p) => ({ ...p, additions: 1, deletions: 0, changedFiles: 1, commits: 1 });
  pulls.record("org/repo#30", sized(pr(31, "draft")));
  pulls.record("org/repo#32", sized(pr(33, "ready", NOW)));
  pulls.record("org/repo#34", sized(pr(35, "draft")));
  pulls.record("org/repo#36", sized(pr(37, "merged")));
  pulls.record("org/broken#1", sized(pr(2, "draft")));
  assert.equal(await pulls.resync(), 4);
  assert.deepEqual(listed, ["org/repo", "org/broken"]);
  assert.deepEqual(fetched, ["org/repo#35", "org/broken#2"]);
  assert.deepEqual(pulls.get("org/repo#30"), { ...sized(pr(31, "ready")), url: "u31" });
  // When it turned ready stays.
  assert.deepEqual(pulls.get("org/repo#32"), { ...sized(pr(33, "merged", NOW)), url: "u33" });
  assert.equal(pulls.get("org/repo#34").state, "closed");
  assert.equal(pulls.get("org/broken#1").state, "closed");
  // Kept, and nothing more to change.
  const next = createPulls({ path, listPulls, getPull });
  assert.equal(next.get("org/repo#30").state, "ready");
  assert.equal(await next.resync(), 0);
});

test("pulls: resync asks for an open one whose size isn't known yet, once; the count is of states", async (t) => {
  const path = tempPath(t);
  const fetched = [];
  const listPulls = async () => [{ number: 31, html_url: "u31", state: "open", draft: true }];
  const getPull = async (repo, number) => {
    fetched.push(number);
    return {
      number,
      html_url: `u${number}`,
      state: "open",
      draft: true,
      additions: 86,
      deletions: 19,
      changed_files: 4,
      commits: 3,
    };
  };
  const pulls = createPulls({ path, listPulls, getPull });
  // From a listing (fill()) or a listener from before sizes: none.
  pulls.record("org/repo#30", pr(31, "draft"));
  assert.equal(await pulls.resync(), 0);
  assert.deepEqual(fetched, [31]);
  const sized = { additions: 86, deletions: 19, changedFiles: 4, commits: 3 };
  assert.deepEqual(pulls.get("org/repo#30"), { ...pr(31, "draft"), url: "u31", ...sized });
  // Saved, and not asked again.
  const next = createPulls({ path, listPulls, getPull });
  assert.deepEqual(next.get("org/repo#30"), pulls.get("org/repo#30"));
  await next.resync();
  assert.deepEqual(fetched, [31]);
  // GitHub can't say: the listing's state still counts.
  const gone = createPulls({ path: tempPath(t), listPulls, getPull: async () => null });
  gone.record("org/repo#30", pr(31, "ready"));
  assert.equal(await gone.resync(), 1);
  assert.equal(gone.get("org/repo#30").state, "draft");
});

test("pulls: a pull request recorded without its size keeps the one known", (t) => {
  const pulls = createPulls({ path: tempPath(t), listPulls: async () => [] });
  const sized = { additions: 86, deletions: 19, changedFiles: 4, commits: 3 };
  pulls.record("org/repo#30", { ...pr(31, "draft"), ...sized });
  // The listener's own change (pr-ready.mjs), its object without them.
  pulls.record("org/repo#30", pr(31, "ready", NOW));
  assert.deepEqual(pulls.get("org/repo#30"), { ...pr(31, "ready", NOW), ...sized });
  // A newer size wins.
  pulls.record("org/repo#30", { ...pr(31, "ready"), ...sized, commits: 5 });
  assert.equal(pulls.get("org/repo#30").commits, 5);
  // Another pull request on the task: not the old one's size.
  pulls.record("org/repo#30", pr(40, "draft"));
  assert.deepEqual(pulls.get("org/repo#30"), pr(40, "draft"));
});

test("pulls: resync lets fill() look up the tasks without one again", async (t) => {
  let asked = 0;
  const listPulls = async () => (asked++, []);
  const pulls = createPulls({ path: tempPath(t), listPulls });
  await pulls.fill(["org/repo#4"]);
  await pulls.fill(["org/repo#4"]);
  assert.equal(asked, 1);
  await pulls.resync();
  await pulls.fill(["org/repo#4"]);
  assert.equal(asked, 2);
});

test("pulls: a ready pull request recorded ready again keeps when it turned ready", (t) => {
  const pulls = createPulls({ path: tempPath(t), listPulls: async () => [] });
  // pr-ready.mjs, then its ready_for_review delivery: one readyAt, one notification.
  pulls.record("org/repo#30", pr(31, "ready", NOW));
  pulls.record("org/repo#30", pr(31, "ready", NOW + 5000));
  assert.equal(pulls.get("org/repo#30").readyAt, NOW);
  // Back to draft, then ready again: a new one.
  pulls.record("org/repo#30", pr(31, "draft"));
  pulls.record("org/repo#30", pr(31, "ready", NOW + 9000));
  assert.equal(pulls.get("org/repo#30").readyAt, NOW + 9000);
});

test("a redelivered pull_request delivery: as the pull request is now", () => {
  const now = (pr) => ({ number: 31, state: "open", draft: false, merged: false, ...pr });
  const replay = (action, current) => replayedPull(delivery(action), now(current)).action;
  // Still what it says: kept, with the current pull request.
  assert.equal(replay("ready_for_review", {}), "ready_for_review");
  assert.equal(replay("converted_to_draft", { draft: true }), "converted_to_draft");
  assert.equal(replay("opened", { draft: true }), "opened");
  assert.equal(replay("closed", { state: "closed", merged: true }), "closed");
  assert.equal(replay("synchronize", { state: "closed" }), "synchronize");
  // No longer: an edit, which records its state and nothing else.
  assert.equal(replay("ready_for_review", { state: "closed", merged: true }), "edited");
  assert.equal(replay("ready_for_review", { draft: true }), "edited");
  assert.equal(replay("converted_to_draft", {}), "edited");
  assert.equal(replay("reopened", { state: "closed" }), "edited");
  assert.equal(replay("closed", {}), "edited");
  const merged = replayedPull(delivery("ready_for_review"), now({ state: "closed", merged: true }));
  assert.deepEqual(pullRequest(config, "pull_request", merged, NOW).pr, {
    number: 31,
    url: undefined,
    state: "merged",
    readyAt: null,
  });
});
