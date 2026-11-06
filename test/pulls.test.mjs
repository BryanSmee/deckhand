import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ciDelivery, pullRequest, replayedPull } from "../listener/events.mjs";
import { commitCi } from "../listener/ci.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { mapStore, tempDir, testConfig } from "./helpers.mjs";

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

test("pull_request deliveries: its head commit, a push's new one too (#535)", () => {
  const at = (sha) => ({ head: { sha, ref: "issue-30-fix", repo: { full_name: "Org/Repo" } } });
  assert.equal(map("opened", at("aaa111")).pr.head, "aaa111");
  assert.equal(map("synchronize", at("bbb222")).pr.head, "bbb222");
  // A payload without it: none, so the one recorded stays (pulls.mjs record()).
  assert.equal("head" in map("opened").pr, false);
});

test("pull_request deliveries outside the allowlist, the App or the actions are ignored", () => {
  assert.equal(map("opened", {}, { repo: "Org/Other" }), null);
  assert.equal(map("opened", {}, { installation: null }), null);
  assert.equal(map("labeled"), null);
  assert.equal(pullRequest(config, "issue_comment", delivery("opened"), NOW), null);
});

// Where a release before kept them: the store's map takes what it finds there.
const tempPath = (t) => join(tempDir(t), "pulls.json");
const saved = async (maps) => Object.fromEntries(await maps.again("pulls"));
const pr = (number, state, readyAt = null) => ({
  number,
  url: `https://github.com/org/repo/pull/${number}`,
  state,
  readyAt,
});

test("pulls: recorded per task, and kept across a restart", async (t) => {
  const path = tempPath(t);
  const maps = mapStore();
  const pulls = createPulls({
    pulls: await maps.map("pulls", { file: path }),
    listPulls: async () => [],
  });
  pulls.record("org/repo#30", pr(31, "draft"));
  pulls.record("org/repo#30", pr(31, "ready", NOW));
  assert.deepEqual(pulls.get("org/repo#30"), pr(31, "ready", NOW));
  // Merged: when it turned ready stays.
  pulls.record("org/repo#30", pr(31, "merged"));
  assert.deepEqual(pulls.get("org/repo#30"), pr(31, "merged", NOW));
  assert.equal(pulls.get("org/repo#29"), null);

  assert.deepEqual((await saved(maps))["org/repo#30"], pr(31, "merged", NOW));
  const next = createPulls({ pulls: await maps.again("pulls"), listPulls: async () => [] });
  assert.deepEqual(next.get("org/repo#30"), pr(31, "merged", NOW));
});

test("pulls: a machine's mark is kept per pull request, a newer one on the task leaving it (#947)", async () => {
  const maps = mapStore();
  const pulls = createPulls({
    pulls: await maps.map("pulls"),
    marks: await maps.map("marks"),
    listPulls: async () => [],
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), external: "alice" });
  assert.equal(pulls.externalOf("Org/Repo", 31), "alice");
  // Another pull request becomes the task's: the older one, still open, stays alice's.
  pulls.record("org/repo#30", pr(32, "draft"));
  assert.equal(pulls.get("org/repo#30").external, undefined);
  assert.equal(pulls.externalOf("org/repo", 31), "alice");
  assert.equal(pulls.externalOf("org/repo", 32), null);
  assert.equal(pulls.externalOf("org/other", 31), null);
  // The task's again (a delivery of it): its entry has the mark back.
  pulls.record("org/repo#30", pr(31, "ready"));
  assert.equal(pulls.get("org/repo#30").external, "alice");
  // In the store: the next copy has it.
  const next = createPulls({
    pulls: await maps.again("pulls"),
    marks: await maps.again("marks"),
    listPulls: async () => [],
  });
  assert.equal(next.externalOf("org/repo", 31), "alice");
});

test("pulls: a mark kept in the task's entry alone, before marks were (#947), is taken at start", async () => {
  const maps = mapStore();
  const before = await maps.map("pulls");
  before.set("Org/Repo#30", { ...pr(31, "ready"), external: "alice" });
  const marks = await maps.map("marks");
  const pulls = createPulls({ pulls: before, marks, listPulls: async () => [] });
  assert.equal(pulls.externalOf("org/repo", 31), "alice");
  pulls.record("org/repo#30", pr(32, "draft"));
  assert.equal(pulls.externalOf("org/repo", 31), "alice");
  assert.deepEqual(Object.fromEntries(await maps.again("marks")), { "org/repo#31": "alice" });
});

test("pulls: an edited link moves the pull request; a closed one doesn't hide an open one", (t) => {
  const pulls = createPulls({ listPulls: async () => [] });
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
  const pulls = createPulls({ listPulls: async () => [] });
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
  const pulls = createPulls({ listPulls });
  pulls.record("storywake/storywake#5", pr(6, "draft"));
  await pulls.fill(["Storywake/storywake#5"]);
  assert.deepEqual(asked, []);
  assert.deepEqual(pulls.keys(), ["storywake/storywake#5"]);
});

test("pulls: respelled, both spellings of one pull request merged, the open one of two kept", async (t) => {
  const path = tempPath(t);
  const maps = mapStore();
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
  const pulls = createPulls({
    pulls: await maps.map("pulls", { file: path }),
    listPulls: async () => [],
  });
  pulls.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(await saved(maps), {
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
  const pulls = createPulls({ listPulls });
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
  const maps = mapStore();
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
  const pulls = createPulls({ pulls: await maps.map("pulls", { file: path }), listPulls, getPull });
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
  assert.equal(
    createPulls({ pulls: await maps.again("pulls"), listPulls, getPull }).get("org/repo#4").commits,
    3,
  );
});

test("pulls: the open ones, for the conflict watcher", (t) => {
  const pulls = createPulls({ listPulls: async () => [] });
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
  const maps = mapStore();
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
  const pulls = createPulls({ pulls: await maps.map("pulls", { file: path }), listPulls, getPull });
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
  const next = createPulls({ pulls: await maps.again("pulls"), listPulls, getPull });
  assert.equal(next.get("org/repo#30").state, "ready");
  assert.equal(await next.resync(), 0);
});

test("pulls: resync asks for an open one whose size isn't known yet, once; the count is of states", async (t) => {
  const path = tempPath(t);
  const maps = mapStore();
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
  const pulls = createPulls({ pulls: await maps.map("pulls", { file: path }), listPulls, getPull });
  // From a listing (fill()) or a listener from before sizes: none.
  pulls.record("org/repo#30", pr(31, "draft"));
  assert.equal(await pulls.resync(), 0);
  assert.deepEqual(fetched, [31]);
  const sized = { additions: 86, deletions: 19, changedFiles: 4, commits: 3 };
  assert.deepEqual(pulls.get("org/repo#30"), { ...pr(31, "draft"), url: "u31", ...sized });
  // Saved, and not asked again.
  const next = createPulls({ pulls: await maps.again("pulls"), listPulls, getPull });
  assert.deepEqual(next.get("org/repo#30"), pulls.get("org/repo#30"));
  await next.resync();
  assert.deepEqual(fetched, [31]);
  // GitHub can't say: the listing's state still counts.
  const gone = createPulls({ listPulls, getPull: async () => null });
  gone.record("org/repo#30", pr(31, "ready"));
  assert.equal(await gone.resync(), 1);
  assert.equal(gone.get("org/repo#30").state, "draft");
});

test("pulls: a pull request recorded without its size keeps the one known", (t) => {
  const pulls = createPulls({ listPulls: async () => [] });
  const sized = { additions: 86, deletions: 19, changedFiles: 4, commits: 3 };
  pulls.record("org/repo#30", { ...pr(31, "draft"), ...sized });
  // The listener's own record (github-pulls.mjs), its object without them.
  pulls.record("org/repo#30", pr(31, "ready", NOW));
  assert.deepEqual(pulls.get("org/repo#30"), { ...pr(31, "ready", NOW), ...sized });
  // A newer size wins.
  pulls.record("org/repo#30", { ...pr(31, "ready"), ...sized, commits: 5 });
  assert.equal(pulls.get("org/repo#30").commits, 5);
  // Another pull request on the task: not the old one's size.
  pulls.record("org/repo#30", pr(40, "draft"));
  assert.deepEqual(pulls.get("org/repo#30"), pr(40, "draft"));
});

test("pulls: the head commit, kept across a restart, from deliveries, listings and resync (#535)", async (t) => {
  const path = tempPath(t);
  const maps = mapStore();
  let head = "bbb222";
  const listPulls = async () => [
    { number: 31, html_url: "u31", state: "open", draft: false, head: { sha: head } },
    {
      number: 41,
      html_url: "u41",
      body: "Closes #40",
      state: "open",
      draft: false,
      head: { sha: "ccc333", ref: "issue-40-x", repo: { full_name: "org/repo" } },
    },
  ];
  const sized = { additions: 1, deletions: 0, changedFiles: 1, commits: 1 };
  const getPull = async (repo, number) => ({
    number,
    html_url: `u${number}`,
    state: "open",
    draft: false,
    head: { sha: number === 41 ? "ccc333" : head },
    additions: 1,
    deletions: 0,
    changed_files: 1,
    commits: 1,
  });
  const pulls = createPulls({ pulls: await maps.map("pulls", { file: path }), listPulls, getPull });
  pulls.record("org/repo#30", { ...pr(31, "ready", NOW), head: "aaa111", ...sized });
  // The listener's own record, its object without a head: the one known stays.
  pulls.record("org/repo#30", pr(31, "ready", NOW));
  assert.equal(pulls.get("org/repo#30").head, "aaa111");
  // A listing finds an older task's, with its head.
  await pulls.fill(["org/repo#40"]);
  assert.equal(pulls.get("org/repo#40").head, "ccc333");
  // A push whose delivery was lost: resync catches it up, not counted as a state change.
  assert.equal(await pulls.resync(), 0);
  assert.equal(pulls.get("org/repo#30").head, "bbb222");
  const next = createPulls({ pulls: await maps.again("pulls"), listPulls, getPull });
  assert.equal(next.get("org/repo#30").head, "bbb222");
  assert.equal(next.get("org/repo#40").head, "ccc333");
});

test("pulls: resync lets fill() look up the tasks without one again", async (t) => {
  let asked = 0;
  const listPulls = async () => (asked++, []);
  const pulls = createPulls({ listPulls });
  await pulls.fill(["org/repo#4"]);
  await pulls.fill(["org/repo#4"]);
  assert.equal(asked, 1);
  await pulls.resync();
  await pulls.fill(["org/repo#4"]);
  assert.equal(asked, 2);
});

test("pulls: a ready pull request recorded ready again keeps when it turned ready", (t) => {
  const pulls = createPulls({ listPulls: async () => [] });
  // github-pulls.mjs, then its ready_for_review delivery: one readyAt, one notification.
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
  // A label: kept while the pull request still has it (labeled) or still hasn't (unlabeled).
  const label = (action, labels) =>
    replayedPull({ ...delivery(action), label: { name: "needs-input" } }, now({ labels })).action;
  assert.equal(label("labeled", [{ name: "Needs-Input" }]), "labeled");
  assert.equal(label("labeled", []), "edited");
  assert.equal(label("unlabeled", []), "unlabeled");
  assert.equal(label("unlabeled", [{ name: "needs-input" }]), "edited");
  // The payload's own updated_at, when it happened: the current one is newer.
  const then = delivery("unlabeled", { updated_at: "2026-10-30T09:00:00Z" });
  const replayed = replayedPull(then, now({ updated_at: "2026-10-31T09:00:00Z" }));
  assert.equal(replayed.replayed_updated_at, "2026-10-30T09:00:00Z");
  assert.equal(replayed.pull_request.updated_at, "2026-10-31T09:00:00Z");
  const merged = replayedPull(delivery("ready_for_review"), now({ state: "closed", merged: true }));
  assert.deepEqual(pullRequest(config, "pull_request", merged, NOW).pr, {
    number: 31,
    url: undefined,
    state: "merged",
    readyAt: null,
  });
});

test("pull_request deliveries: the head commit, whose CI the dashboard shows", () => {
  assert.equal(map("synchronize", { head: { ref: "issue-30-fix", sha: "b2" } }).pr.head, "b2");
  assert.equal("head" in map("opened").pr, false);
});

// A pulls store whose CI reads answer from `answers` (sha → ci, or a function of the call),
// recording the commits read.
function ciPulls(t, answers = {}) {
  const read = [];
  const pulls = createPulls({
    listPulls: async () => [],
    readCi: async (repo, sha) => {
      read.push(`${repo}@${sha}`);
      const answer = answers[sha];
      return typeof answer === "function" ? answer() : (answer ?? null);
    },
  });
  return { pulls, read };
}
const ci = (sha, state, runs = []) => ({ sha, state, runs });
const failedRun = {
  name: "test",
  state: "failed",
  url: "https://github.com/org/repo/actions/runs/9",
};

// Waits for the reads started without a caller waiting (record()'s).
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("pulls: CI of the head read when it moves and when a delivery says it changed, an older commit's ignored", async (t) => {
  const answers = { a1: ci("a1", "running"), b2: ci("b2", "running") };
  const { pulls, read } = ciPulls(t, answers);
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  // A new pull request starts with nothing reported, then its CI is read: a delivery for its
  // head may have come before its own.
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "none"));
  await settled();
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "running"));
  answers.a1 = ci("a1", "passed");
  await pulls.ciChanged("Org/Repo", "a1");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "passed"));
  // Another commit, or another repo's: nothing read.
  await pulls.ciChanged("org/repo", "zz");
  await pulls.ciChanged("org/other", "a1");
  assert.deepEqual(read, ["org/repo@a1", "org/repo@a1"]);
  // A push: back to nothing reported at the new head, then read; the old head's runs no longer
  // count.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "b2" });
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("b2", "none"));
  await settled();
  await pulls.ciChanged("org/repo", "a1");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("b2", "running"));
  answers.b2 = ci("b2", "failed", [failedRun]);
  await pulls.ciChanged("org/repo", "b2");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("b2", "failed", [failedRun]));
  // An edit without a head keeps head and CI, and reads nothing; a merge keeps the last CI
  // known, and isn't read.
  pulls.record("org/repo#30", pr(31, "ready"));
  assert.equal(pulls.get("org/repo#30").ci.state, "failed");
  pulls.record("org/repo#30", { ...pr(31, "merged"), head: "b2" });
  await pulls.ciChanged("org/repo", "b2");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("b2", "failed", [failedRun]));
  assert.deepEqual(read, ["org/repo@a1", "org/repo@a1", "org/repo@b2", "org/repo@b2"]);
});

test("pulls: CI deliveries while one is read cost one read more, not one each", async (t) => {
  const releases = [];
  const answers = {
    a1: () => new Promise((resolve) => releases.push(() => resolve(ci("a1", "passed")))),
  };
  const { pulls, read } = ciPulls(t, answers);
  // Recorded: the read its head starts is the one the deliveries below find going.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  const all = [1, 2, 3, 4].map(() => pulls.ciChanged("org/repo", "a1"));
  releases.shift()();
  await settled();
  releases.shift()();
  await Promise.all(all);
  assert.deepEqual(read, ["org/repo@a1", "org/repo@a1"]);
  assert.equal(pulls.get("org/repo#30").ci.state, "passed");
});

test("pulls: a CI read that failed is tried again when a delivery asked meanwhile", async (t) => {
  let calls = 0;
  let fail;
  const answers = {
    a1: () => {
      calls++;
      if (calls === 1) return new Promise((resolve, reject) => (fail = reject));
      return ci("a1", "passed");
    },
  };
  const { pulls } = ciPulls(t, answers);
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  const asked = pulls.ciChanged("org/repo", "a1");
  fail(new Error("GitHub is down"));
  await asked;
  assert.equal(calls, 2);
  assert.equal(pulls.get("org/repo#30").ci.state, "passed");
});

test("pulls: CI read for one head isn't kept once the pull request moved to another", async (t) => {
  let pulls;
  let moved = false;
  const answers = {
    a1: async () => {
      if (!moved) {
        moved = true;
        pulls.record("org/repo#30", { ...pr(31, "ready"), head: "b2" });
      }
      return ci("a1", "failed");
    },
  };
  ({ pulls } = ciPulls(t, answers));
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  await settled();
  await settled();
  // b2 read nothing (null): reset, not a1's.
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("b2", "none"));
});

test("pulls: resync reads, after it resolves, the CI of the open ones not settled for their head", async (t) => {
  const path = tempPath(t);
  const maps = mapStore();
  const read = [];
  let reading = false;
  const readCi = async (repo, sha) => {
    if (!reading) return null;
    read.push(sha);
    if (sha === "err") throw new Error("boom");
    return ci(sha, "passed");
  };
  const listPulls = async () => [
    { number: 31, html_url: "u31", state: "open", draft: false, head: { sha: "a1" } },
    // Pushed to without its delivery: the listing has its new head.
    { number: 33, html_url: "u33", state: "open", draft: false, head: { sha: "c3" } },
    { number: 35, html_url: "u35", state: "open", draft: false, head: { sha: "err" } },
  ];
  const sized = (p) => ({ ...p, additions: 1, deletions: 0, changedFiles: 1, commits: 1 });
  const logs = [];
  const pulls = createPulls({
    pulls: await maps.map("pulls", { file: path }),
    listPulls,
    readCi,
    log: (line) => logs.push(line),
  });
  // Recorded while GitHub answers nothing of their CI.
  pulls.record("org/repo#30", sized({ ...pr(31, "ready"), head: "a1" }));
  pulls.record("org/repo#32", sized({ ...pr(33, "ready"), head: "b2" }));
  pulls.record("org/repo#34", sized({ ...pr(35, "ready"), head: "err" }));
  pulls.record("org/repo#36", sized({ ...pr(37, "merged"), head: "d4" }));
  await settled();
  reading = true;
  await pulls.resync();
  await pulls.caughtUp();
  assert.deepEqual(read.sort(), ["a1", "c3", "err"]);
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "passed"));
  assert.equal(pulls.get("org/repo#32").head, "c3");
  assert.deepEqual(pulls.get("org/repo#32").ci, ci("c3", "passed"));
  assert.deepEqual(pulls.get("org/repo#34").ci, ci("err", "none"));
  assert.ok(
    logs.some((l) => /org\/repo#34: CI of #35: boom/.test(l)),
    logs.join("\n"),
  );
  // Settled: not read again, after a restart either; the one that failed is.
  const next = createPulls({ pulls: await maps.again("pulls"), listPulls, readCi });
  assert.deepEqual(next.get("org/repo#30").ci, ci("a1", "passed"));
  read.length = 0;
  await next.resync();
  await next.caughtUp();
  assert.deepEqual(read, ["err"]);
});

test("pulls: a CI read GitHub failed (a 502) leaves the CI known as it was", async (t) => {
  let fail = false;
  const answers = {
    a1: () => {
      if (fail) throw new Error("GitHub GET /repos/org/repo/commits/a1/status: 502");
      return ci("a1", "failed", [failedRun]);
    },
  };
  const { pulls } = ciPulls(t, answers);
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  await settled();
  fail = true;
  await pulls.ciChanged("org/repo", "a1");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "failed", [failedRun]));
});

test("pulls: a CI read that ends while resync waits on GitHub: its state still applied, the CI read kept", async (t) => {
  let listed;
  const listing = new Promise((resolve) => (listed = resolve));
  const listPulls = () => listing;
  let answer = null;
  const pulls = createPulls({
    listPulls,
    readCi: async (repo, sha) => answer && ci(sha, answer),
  });
  const sized = (p) => ({ ...p, additions: 1, deletions: 0, changedFiles: 1, commits: 1 });
  pulls.record("org/repo#30", sized({ ...pr(31, "ready"), head: "a1" }));
  await settled();
  const syncing = pulls.resync();
  // Its CI read meanwhile: only `ci` changes.
  answer = "passed";
  await pulls.ciChanged("org/repo", "a1");
  // Merged while its delivery was lost.
  listed([
    { number: 31, html_url: "u31", state: "closed", merged_at: "2026-11-01", head: { sha: "a1" } },
  ]);
  assert.equal(await syncing, 1);
  assert.equal(pulls.get("org/repo#30").state, "merged");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "passed"));
});

test("ciDelivery: an Actions run, a check suite or a status → the commit, for allowed repos from the App", () => {
  const base = { installation: { id: 7 }, repository: { full_name: "org/repo" } };
  const of = (event, p) => ciDelivery(config, event, { ...base, ...p });
  for (const action of ["requested", "in_progress", "completed"]) {
    assert.deepEqual(of("workflow_run", { action, workflow_run: { head_sha: "a1" } }), {
      repo: "org/repo",
      sha: "a1",
    });
  }
  assert.deepEqual(of("check_suite", { action: "completed", check_suite: { head_sha: "b2" } }), {
    repo: "org/repo",
    sha: "b2",
  });
  assert.deepEqual(of("status", { sha: "c3", state: "failure" }), { repo: "org/repo", sha: "c3" });
  // Another repository, no installation, no commit, another event: none.
  assert.equal(of("status", { sha: "c3", repository: { full_name: "else/where" } }), null);
  assert.equal(of("status", { sha: "c3", installation: undefined }), null);
  assert.equal(of("status", {}), null);
  assert.equal(of("workflow_run", { workflow_run: {} }), null);
  assert.equal(of("check_suite", { sha: "c3" }), null);
  assert.equal(of("pull_request", { sha: "c3", workflow_run: { head_sha: "a1" } }), null);
});

test("pulls: a rate-limited CI read (a 403) leaves the CI known as it was", async (t) => {
  let limited = false;
  const github = async (repo, method, path) => {
    if (path.includes("/actions/runs")) {
      return new Response(JSON.stringify({ workflow_runs: [] }));
    }
    if (path.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: [] }));
    if (limited) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      });
    }
    const failed = { context: "ci/jenkins", state: "failure", target_url: "https://ci/1" };
    return new Response(JSON.stringify({ statuses: [failed] }));
  };
  const pulls = createPulls({
    listPulls: async () => [],
    readCi: (repo, sha) => commitCi(github, repo, sha),
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  await settled();
  const failed = ci("a1", "failed", [{ name: "ci/jenkins", state: "failed", url: "https://ci/1" }]);
  assert.deepEqual(pulls.get("org/repo#30").ci, failed);
  limited = true;
  await pulls.ciChanged("org/repo", "a1");
  assert.deepEqual(pulls.get("org/repo#30").ci, failed);
});

test("pulls: an older delivery handled late doesn't move the head back", async (t) => {
  const { pulls, read } = ciPulls(t, { b2: ci("b2", "passed") });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "b2", updatedAt: 2000 });
  await settled();
  // The `synchronize` of the commit before, handled after.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", updatedAt: 1000 });
  await settled();
  assert.equal(pulls.get("org/repo#30").head, "b2");
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("b2", "passed"));
  assert.deepEqual(read, ["org/repo@b2"]);
  // A newer one moves it, and when it wasn't said, the latest handled does.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "c3", updatedAt: 3000 });
  assert.equal(pulls.get("org/repo#30").head, "c3");
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "d4" });
  assert.equal(pulls.get("org/repo#30").head, "d4");
  assert.equal(pulls.get("org/repo#30").updatedAt, 3000);
});

test("pulls: an open pull request fill() finds for an older task gets its CI read; a closed one doesn't", async (t) => {
  const read = [];
  const pulls = createPulls({
    listPulls: async () => [
      {
        number: 31,
        html_url: "u31",
        state: "open",
        draft: false,
        body: "Closes #30",
        head: { sha: "a1", ref: "x", repo: { full_name: "org/repo" } },
      },
      {
        number: 33,
        html_url: "u33",
        state: "closed",
        merged_at: "2026-11-01",
        body: "Closes #32",
        head: { sha: "b2", ref: "y", repo: { full_name: "org/repo" } },
      },
    ],
    getPull: async () => null,
    readCi: async (repo, sha) => (read.push(sha), ci(sha, "passed")),
  });
  await pulls.fill(["org/repo#30", "org/repo#32"]);
  await pulls.caughtUp();
  assert.deepEqual(read, ["a1"]);
  assert.deepEqual(pulls.get("org/repo#30").ci, ci("a1", "passed"));
  assert.equal(pulls.get("org/repo#32").state, "merged");
  assert.equal(pulls.get("org/repo#32").ci, undefined);
});

test("pulls: a failed CI read on a settled head is read again at the next resync, kept across a restart", async (t) => {
  const path = tempPath(t);
  const maps = mapStore();
  let fail = false;
  const read = [];
  const readCi = async (repo, sha) => {
    read.push(sha);
    if (fail) throw new Error("GitHub GET /repos/org/repo/commits/a1/status: 403");
    return ci(sha, read.length > 2 ? "failed" : "passed");
  };
  const listPulls = async () => [];
  const sized = (p) => ({ ...p, additions: 1, deletions: 0, changedFiles: 1, commits: 1 });
  const pulls = createPulls({ pulls: await maps.map("pulls", { file: path }), listPulls, readCi });
  pulls.record("org/repo#30", sized({ ...pr(31, "ready"), head: "a1" }));
  await settled();
  assert.equal(pulls.get("org/repo#30").ci.state, "passed");
  // Settled: the next resync at start leaves it.
  await pulls.resync();
  await pulls.caughtUp();
  assert.deepEqual(read, ["a1"]);
  // A failure was posted, and its read failed: the green check may be wrong now.
  fail = true;
  await pulls.ciChanged("org/repo", "a1");
  assert.equal(pulls.get("org/repo#30").ciFailed, true);
  assert.equal(pulls.get("org/repo#30").ci.state, "passed");
  fail = false;
  const next = createPulls({ pulls: await maps.again("pulls"), listPulls, readCi });
  await next.resync();
  await next.caughtUp();
  assert.equal(next.get("org/repo#30").ci.state, "failed");
  assert.equal("ciFailed" in next.get("org/repo#30"), false);
});

test("pulls: resync({ all }) reads the CI of every open pull request, settled ones too", async (t) => {
  const read = [];
  const sized = (p) => ({ ...p, additions: 1, deletions: 0, changedFiles: 1, commits: 1 });
  const passed = createPulls({
    listPulls: async () => [],
    readCi: async (repo, sha) => (read.push(sha), ci(sha, "passed")),
  });
  passed.record("org/repo#30", sized({ ...pr(31, "ready"), head: "a1" }));
  passed.record("org/repo#32", sized({ ...pr(33, "merged"), head: "b2" }));
  await settled();
  read.length = 0;
  await passed.resync();
  await passed.caughtUp();
  assert.deepEqual(read, []);
  await passed.resync({ all: true });
  await passed.caughtUp();
  assert.deepEqual(read, ["a1"]);
});

test("pulls: the head resync found keeps GitHub's time: an older synchronize handled after doesn't move it back", async (t) => {
  const listPulls = async () => [
    {
      number: 31,
      html_url: "u31",
      state: "open",
      draft: false,
      head: { sha: "c3" },
      updated_at: "2026-11-02T10:00:00Z",
    },
  ];
  const pulls = createPulls({ listPulls, readCi: async () => null });
  const sized = (p) => ({ ...p, additions: 1, deletions: 0, changedFiles: 1, commits: 1 });
  pulls.record("org/repo#30", sized({ ...pr(31, "ready"), head: "a1", updatedAt: 1000 }));
  await pulls.resync();
  assert.equal(pulls.get("org/repo#30").head, "c3");
  assert.equal(pulls.get("org/repo#30").updatedAt, Date.parse("2026-11-02T10:00:00Z"));
  // The synchronize of b2, between a1 and c3, redelivered by the same Sync.
  const b2 = Date.parse("2026-11-02T09:00:00Z");
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "b2", updatedAt: b2 });
  assert.equal(pulls.get("org/repo#30").head, "c3");
});

test("pull_request deliveries: whether it conflicts with its base, once GitHub computed it (#638)", () => {
  assert.equal(map("edited", { mergeable: false, mergeable_state: "dirty" }).pr.conflict, true);
  assert.equal(map("edited", { mergeable: true, mergeable_state: "clean" }).pr.conflict, false);
  // Behind its base, or blocked by a required check: it merges, no conflict.
  assert.equal(map("edited", { mergeable: true, mergeable_state: "behind" }).pr.conflict, false);
  // Not computed yet, as webhooks often send it: nothing said, the one known stays.
  assert.equal("conflict" in map("opened", { mergeable: null }).pr, false);
  assert.equal(
    "conflict" in map("edited", { mergeable: true, mergeable_state: "unknown" }).pr,
    false,
  );
  assert.equal("conflict" in map("opened").pr, false);
});

test("pulls: a conflict kept through a delivery that doesn't say, forgotten on a new head (#638)", async (t) => {
  const { pulls } = ciPulls(t);
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", conflict: true, updatedAt: 2000 });
  // `mergeable: null` (pullEntry() leaves `conflict` out): the last known value stays.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", updatedAt: 2500 });
  assert.equal(pulls.get("org/repo#30").conflict, true);
  // An older delivery handled late doesn't change it.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", conflict: false, updatedAt: 1000 });
  assert.equal(pulls.get("org/repo#30").conflict, true);
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", conflict: false, updatedAt: 3000 });
  assert.equal(pulls.get("org/repo#30").conflict, false);
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", conflict: true, updatedAt: 3500 });
  // A push: unknown again until GitHub says.
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "b2", updatedAt: 4000 });
  assert.equal("conflict" in pulls.get("org/repo#30"), false);
  await settled();
});

test("pulls: the conflict watcher's read and resync's say whether it conflicts (#638)", async (t) => {
  let found = { mergeable: false, mergeable_state: "dirty" };
  const pulls = createPulls({
    listPulls: async () => [],
    getPull: async (repo, number) => ({
      number,
      html_url: `u${number}`,
      state: "open",
      draft: false,
      head: { sha: "a1" },
      additions: 1,
      deletions: 0,
      changed_files: 1,
      commits: 1,
      ...found,
    }),
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  await pulls.resync();
  assert.equal(pulls.get("org/repo#30").conflict, true);
  // Not computed this time: kept.
  found = { mergeable: null };
  await pulls.resync();
  assert.equal(pulls.get("org/repo#30").conflict, true);
  // The watcher's read, at the head recorded; another head's or another pull request's isn't.
  pulls.sawMerge("org/repo#30", { number: 31, head: { sha: "zz" }, mergeable: true });
  pulls.sawMerge("org/repo#30", { number: 32, head: { sha: "a1" }, mergeable: true });
  pulls.sawMerge("org/repo#30", { number: 31, head: { sha: "a1" }, mergeable: null });
  assert.equal(pulls.get("org/repo#30").conflict, true);
  pulls.sawMerge("org/repo#30", { number: 31, head: { sha: "a1" }, mergeable: true });
  assert.equal(pulls.get("org/repo#30").conflict, false);
  // A head resync found moved: forgotten, unless GitHub said for the new one.
  found = { mergeable: null, head: { sha: "b2" } };
  await pulls.resync();
  assert.equal("conflict" in pulls.get("org/repo#30"), false);
  await pulls.caughtUp();
});

test("pulls: fill() takes whether it conflicts from the pull request it reads, at the head recorded (#638)", async () => {
  const getPull = async (repo, number) => ({
    number,
    state: "open",
    draft: false,
    head: { sha: number === 31 ? "a1" : "zz" },
    mergeable: false,
    mergeable_state: "dirty",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    commits: 1,
  });
  const pulls = createPulls({ listPulls: async () => [], getPull });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1" });
  pulls.record("org/repo#32", { ...pr(33, "ready"), head: "a1" });
  await pulls.fill(["org/repo#30", "org/repo#32"]);
  assert.equal(pulls.get("org/repo#30").conflict, true);
  // Read at another head than the one recorded: says nothing of this one; its size still kept.
  assert.equal("conflict" in pulls.get("org/repo#32"), false);
  assert.equal(pulls.get("org/repo#32").commits, 1);
  await pulls.caughtUp();
});

// A pull request as getPull() reads it, at head a1, with its size, `extra` over it.
const readPull = (number, extra = {}) => ({
  number,
  html_url: `u${number}`,
  state: "open",
  draft: false,
  head: { sha: "a1" },
  additions: 1,
  deletions: 0,
  changed_files: 1,
  commits: 1,
  ...extra,
});

test("pulls: a user's Sync reads every open pull request itself, after it answers (#747)", async () => {
  const asked = [];
  let mergeable = true;
  let release = () => {};
  let held = Promise.resolve();
  const pulls = createPulls({
    listPulls: async () => [readPull(31)],
    getPull: async (repo, number) => {
      asked.push(number);
      await held;
      return readPull(number, { mergeable });
    },
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", additions: 1, conflict: false });
  // At start: listed and sized, not asked about.
  await pulls.resync();
  await pulls.caughtUp();
  assert.deepEqual(asked, []);
  // The base moved meanwhile: the user's Sync sees it, without waiting for GitHub's answer.
  mergeable = false;
  held = new Promise((resolve) => (release = resolve));
  await pulls.resync({ all: true });
  assert.deepEqual(asked, [31]);
  assert.equal(pulls.get("org/repo#30").conflict, false);
  release();
  await pulls.caughtUp();
  assert.equal(pulls.get("org/repo#30").conflict, true);
});

test("pulls: a Sync during the start's resync reads, after it, those it didn't read (#747)", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const asked = [];
  const pulls = createPulls({
    listPulls: async () => (await held, [readPull(31), readPull(33)]),
    getPull: async (repo, number) => (asked.push(number), readPull(number, { mergeable: false })),
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", additions: 1, conflict: false });
  // Without a size: the start's resync reads it, Sync doesn't again.
  pulls.record("org/repo#32", { ...pr(33, "ready"), head: "a1", conflict: false });
  const start = pulls.resync();
  const sync = pulls.resync({ all: true });
  release();
  await start;
  await sync;
  await pulls.caughtUp();
  assert.deepEqual(asked.sort(), [31, 33]);
  assert.equal(pulls.get("org/repo#30").conflict, true);
  assert.equal(pulls.get("org/repo#32").conflict, true);
});

test("pulls: a Sync's reads go a few at a time (#747)", async () => {
  let going = 0;
  let most = 0;
  const pulls = createPulls({
    listPulls: async () => Array.from({ length: 10 }, (_, i) => readPull(101 + i)),
    getPull: async (repo, number) => {
      most = Math.max(most, ++going);
      await new Promise((resolve) => setImmediate(resolve));
      going--;
      return readPull(number, { mergeable: false });
    },
  });
  for (let n = 1; n <= 10; n++) {
    pulls.record(`org/repo#${n}`, { ...pr(100 + n, "ready"), head: "a1", additions: 1 });
  }
  await pulls.resync({ all: true });
  await pulls.caughtUp();
  assert.ok(most > 1 && most <= 4, `${most} at once`);
});

test("pulls: a base that moved has its repo's open pull requests read again after the wait (#747)", async () => {
  const waits = [];
  const sleep = (ms) => new Promise((resolve) => waits.push({ ms, resolve }));
  const wake = async () => {
    while (!waits.length) await new Promise((resolve) => setImmediate(resolve));
    waits.shift().resolve();
  };
  const asked = [];
  const answers = {
    31: [{ mergeable: false }, { mergeable: true }],
    33: [{ mergeable: null }, { mergeable: false }, { mergeable: false }],
  };
  const pulls = createPulls({
    listPulls: async () => [],
    getPull: async (repo, number) => {
      asked.push(`${repo}#${number}`);
      return readPull(number, answers[number]?.shift() ?? {});
    },
    mergeDelayMs: 1234,
    sleep,
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", conflict: false });
  pulls.record("org/repo#32", { ...pr(33, "ready"), head: "a1", conflict: false });
  pulls.record("org/other#34", { ...pr(35, "ready"), head: "a1", conflict: false });
  pulls.record("org/repo#36", { ...pr(37, "merged"), head: "a1", conflict: false });
  // The push and the merged pull request's delivery: one wait, one read each.
  const moved = pulls.baseMoved("org/repo");
  assert.equal(pulls.baseMoved("Org/Repo"), moved);
  await wake();
  assert.equal(pulls.get("org/repo#30").conflict, false);
  await wake();
  // Not computed yet for #33: kept, then read once more after another wait.
  await moved;
  assert.deepEqual(asked, ["org/repo#31", "org/repo#33", "org/repo#33"]);
  assert.deepEqual(waits, []);
  assert.equal(pulls.get("org/repo#30").conflict, true);
  assert.equal(pulls.get("org/repo#32").conflict, true);
  assert.equal(pulls.get("org/other#34").conflict, false);
  // A move after the reads: a wait of its own.
  const again = pulls.baseMoved("org/repo");
  assert.notEqual(again, moved);
  await wake();
  await again;
  assert.equal(pulls.get("org/repo#30").conflict, false);
  await pulls.caughtUp();
});

test("pulls: a base move's read GitHub fails is logged, the others still read (#747)", async () => {
  const logs = [];
  const pulls = createPulls({
    listPulls: async () => [],
    getPull: async (repo, number) => {
      if (number === 31) throw new Error("502");
      return readPull(number, { mergeable: false });
    },
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  pulls.record("org/repo#30", { ...pr(31, "ready"), head: "a1", conflict: false });
  pulls.record("org/repo#32", { ...pr(33, "ready"), head: "a1", conflict: false });
  await pulls.baseMoved("org/repo");
  assert.equal(pulls.get("org/repo#30").conflict, false);
  assert.equal(pulls.get("org/repo#32").conflict, true);
  assert.match(logs.join("\n"), /org\/repo#30 #31: 502/);
  await pulls.caughtUp();
});
