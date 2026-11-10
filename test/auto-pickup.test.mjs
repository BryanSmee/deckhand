import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOON_MS,
  labelAdded,
  labeller,
  labellerRefusal,
  vouchedLabeller,
  pulledIssues,
  pullClosed,
  readyPulls,
} from "../listener/auto-pickup.mjs";
import { ConfigError, loadConfig } from "../listener/config.mjs";
import { parseRepoConfig, startable } from "../listener/repo-config.mjs";
import { runTrigger } from "../listener/run-policy.mjs";
import { createPicks, endPicks } from "../listener/picks.mjs";
import { createTasks, newTask, pickedTask } from "../listener/tasks.mjs";
import { MEMBER, VIEWER, mapStore, permissionsOf, testConfig } from "./helpers.mjs";
import { BOT, issue, labelled, setup } from "./fixtures/auto-pickup.mjs";

test("the oldest labelled issue across the opted-in repos starts, as the labeller's work run", async () => {
  const { pickup, p } = setup({
    repos: {
      "org/a": { issues: [issue(5, 3), issue(6, 9)] },
      "org/b": { issues: [issue(2, 1)] },
    },
    events: { "org/b#2": [labelled("bob"), { event: "unlabeled" }, labelled("carol")] },
  });
  assert.deepEqual(await pickup.sweep(), ["org/b#2"]);
  // The App's comment first (reply()), then the label off, then the run.
  assert.deepEqual(p.removed, ["org/b#2"]);
  assert.match(
    p.comments[0][1],
    /^Picked automatically: the `auto-pickup` label was added by @carol/,
  );
  const [item] = p.accepted;
  assert.equal(item.repo, "org/b");
  assert.equal(item.number, 2);
  assert.equal(item.trigger, "work");
  assert.equal(item.modeLine, null);
  assert.equal(item.author, "carol");
  assert.equal(item.autoPickup, true);
  assert.equal(item.comment.id, 902);
  assert.equal(item.settings.autoPickup, true);
  // What the policies see of it.
  assert.equal(runTrigger(item), "auto-pickup");
});

test("a pick: the App's comment before the label comes off, then the run, logged with its labeller", async () => {
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [issue(12, 1)] } },
    events: { "org/a#12": [labelled("bob")] },
  });
  // What the label's removal and the queue had seen when each step came.
  const steps = [];
  const push = p.comments.push.bind(p.comments);
  p.comments.push = (...x) => (steps.push(["comment", p.removed.length]), push(...x));
  const accepted = p.accepted.push.bind(p.accepted);
  p.accepted.push = (...x) => (steps.push(["run", p.removed.length]), accepted(...x));
  assert.deepEqual(await pickup.sweep(), ["org/a#12"]);
  assert.deepEqual(steps, [
    ["comment", 0],
    ["run", 1],
  ]);
  assert.match(p.comments[0][1], /^Picked automatically: .* added by @bob/);
  assert.deepEqual(p.logs, ["Auto-pickup: org/a#12: started (label added by bob)"]);
});

test("two free slots: the two oldest, in order", async () => {
  const { pickup } = setup({
    env: { MAX_PARALLEL: "4", AUTO_PICKUP_SLOTS: "2" },
    repos: {
      "org/a": { issues: [issue(5, 3), issue(6, 9)] },
      "org/b": { issues: [issue(2, 1)] },
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/b#2", "org/a#5"]);
});

test("each skip reason passes the issue over for the next one", async () => {
  const { pickup, p } = setup({
    repos: {
      "org/a": {
        issues: [
          issue(1, 1, { labels: [{ name: "auto-pickup" }, { name: "needs-input" }] }),
          issue(2, 2),
          issue(3, 3),
          issue(4, 4, { issue_dependencies_summary: { total_blocked_by: 2 } }),
          issue(5, 5),
          issue(6, 6),
          issue(7, 7),
          // A pull request: the issues list has them too.
          issue(8, 8, { pull_request: {} }),
          issue(9, 9),
        ],
        pulls: [
          {
            user: { login: BOT },
            body: "Closes #3",
            head: { ref: "issue-3-x", repo: { full_name: "org/a" } },
          },
          // Not Deckhand's: someone else's pull request for #5 doesn't hold it.
          {
            user: { login: "bob" },
            body: "Closes #5",
            head: { ref: "issue-5-x", repo: { full_name: "org/a" } },
          },
        ],
      },
    },
    live: ["org/a#2"],
    blockers: {
      "org/a#4": [
        { number: 30, state: "closed" },
        { number: 31, state: "open" },
      ],
    },
    events: {
      "org/a#5": [labelled("mallory")],
      "org/a#6": [labelled("alice"), labelled("renovate[bot]", "Bot")],
      "org/a#7": [],
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#9"]);
  assert.deepEqual(p.logs.slice(0, 7), [
    "Auto-pickup: org/a#1: skipped, it has open questions (needs-input)",
    "Auto-pickup: org/a#2: skipped, something is live on it",
    "Auto-pickup: org/a#3: skipped, Deckhand has an open pull request for it",
    "Auto-pickup: org/a#4: skipped, an open issue blocks it",
    "Auto-pickup: org/a#5: skipped, the label was added by mallory, who isn't an allowed user",
    "Auto-pickup: org/a#6: skipped, the label was added by a bot (renovate[bot])",
    "Auto-pickup: org/a#7: skipped, who added the label isn't in its events yet",
  ]);
  assert.deepEqual(p.removed, ["org/a#9"]);
  // The open pull requests and the repo's settings are read once per repo and sweep.
  assert.equal(p.calls.filter((c) => c.includes("/pulls")).length, 1);
  assert.equal(p.settingsReads, 1);
  // Those their labelling holds: the App says why, once.
  const held = p.comments.filter(([, text]) => text.startsWith("Not picked automatically"));
  assert.deepEqual(
    held.map(([key]) => key),
    ["org/a#5", "org/a#6"],
  );
  assert.match(
    held[0][1],
    /^Not picked automatically: the label was added by mallory, who isn't an allowed user\. The `auto-pickup` label stays, but nothing starts until an allowed user adds it again\.\n\n<!-- deckhand:auto-pickup-held \d+ -->$/,
  );
  // A skip is logged when its reason changes, not at each sweep; an issue held by its
  // labelling isn't read again until it changes, nor told again.
  await pickup.sweep();
  assert.equal(p.logs.filter((l) => l.includes("org/a#1")).length, 1);
  assert.equal(p.calls.filter((c) => c.includes("/issues/5/events")).length, 1);
  assert.equal(
    p.comments.filter(([, text]) => text.startsWith("Not picked automatically")).length,
    2,
  );
  // One whose labelling its events don't show yet isn't held: read again.
  assert.equal(p.calls.filter((c) => c.includes("/issues/7/events")).length, 2);
});

test("an issue with a runs-on label is a machine task's: never picked, the next one is", async () => {
  const { pickup, p } = setup({
    repos: {
      "org/a": {
        issues: [
          issue(1, 1, { labels: [{ name: "auto-pickup" }, { name: "runs-on:unreal" }] }),
          issue(2, 2),
        ],
      },
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#2"]);
  assert.ok(
    p.logs.includes("Auto-pickup: org/a#1: skipped, it has a runs-on label: its machines take it"),
    p.logs.join("\n"),
  );
  // Not even its events read, nor its label taken off.
  assert.ok(!p.calls.some((c) => c.includes("/issues/1/")));
  assert.deepEqual(p.removed, ["org/a#2"]);
});

test("a label whose latest labelling isn't in the events yet: no earlier labeller's run, read again", async () => {
  const unlabelled = {
    event: "unlabeled",
    label: { name: "auto-pickup" },
    actor: { login: BOT, type: "Bot" },
  };
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [issue(1, 1)] } },
    // Alice's labelling was picked and the App took the label off; mallory's isn't listed yet.
    events: { "org/a#1": [labelled("alice"), unlabelled] },
  });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(p.accepted, []);
  assert.deepEqual(p.comments, []);
  assert.match(p.logs.at(-1), /org\/a#1: skipped, who added the label isn't in its events yet/);
  // Listed now: mallory's, which isn't an allowed user's.
  p.events["org/a#1"] = [
    labelled("alice"),
    unlabelled,
    labelled("mallory", "User", "2026-03-01T00:00:00Z"),
  ];
  assert.deepEqual(await pickup.sweep(), []);
  assert.match(p.comments[0][1], /the label was added by mallory, who isn't an allowed user/);
});

test("a labeller among ALLOWED_USERS but not the repo's users starts nothing", async () => {
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [issue(1, 1)], settings: "auto_pickup: true\nusers: [bob]" } },
  });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(p.removed, []);
  assert.deepEqual(p.accepted, []);
});

test("a repo whose default branch no longer opts in, or has errors, is skipped", async () => {
  for (const settings of ["auto_pickup: false", "auto_pickup: maybe"]) {
    const { pickup, p } = setup({ repos: { "org/a": { issues: [issue(1, 1)], settings } } });
    assert.deepEqual(await pickup.sweep(), []);
    assert.deepEqual(p.removed, []);
  }
});

test("no free reserved slot, or no slots at all: GitHub isn't even asked", async () => {
  const full = setup({ repos: { "org/a": { issues: [issue(1, 1)] } }, taken: 1 });
  assert.deepEqual(await full.pickup.sweep(), []);
  assert.deepEqual(full.p.calls, []);
  const off = setup({
    env: { AUTO_PICKUP_SLOTS: "0" },
    repos: { "org/a": { issues: [issue(1, 1)] } },
  });
  assert.deepEqual(await off.pickup.sweep(), []);
  assert.deepEqual(off.p.calls, []);
});

test("a label someone took off meanwhile starts nothing; one refused by the policies stays off", async () => {
  const gone = setup({ repos: { "org/a": { issues: [issue(1, 1)] } }, gone: ["org/a#1"] });
  assert.deepEqual(await gone.pickup.sweep(), []);
  assert.match(gone.p.edited[0][1], /not started, the label was taken off meanwhile/);
  assert.deepEqual(gone.p.accepted, []);

  const refused = setup({ repos: { "org/a": { issues: [issue(1, 1)] } }, refuse: true });
  assert.deepEqual(await refused.pickup.sweep(), []);
  assert.deepEqual(refused.p.removed, ["org/a#1"]);
  assert.match(refused.p.logs.at(-1), /not started, refused by the policies/);
  // Its comment says so, as the dashboard's does.
  assert.deepEqual(
    refused.p.edited.map(([path]) => path),
    ["/repos/org/a/issues/comments/901"],
  );
  assert.match(refused.p.edited[0][1], /not started, the policies refuse it\. Add the label again/);
});

test("a label that can't be taken off: not started, said once, not picked again until labelled again", async () => {
  const issues = [issue(1, 1)];
  const { pickup, p } = setup({ repos: { "org/a": { issues } }, stuck: ["org/a#1"] });
  assert.deepEqual(await pickup.sweep(), []);
  assert.equal(p.comments.length, 1);
  assert.deepEqual(p.accepted, []);
  assert.match(
    p.edited[0][1],
    /not started, the label couldn't be taken off\. Take the label off and add it again to retry\./,
  );
  assert.match(p.logs.at(-1), /org\/a#1: taking the label off: 500/);
  // The next sweeps: the label still on, but no other comment.
  issues[0] = { ...issues[0], updated_at: "2026-02-02T00:00:00Z" };
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(await pickup.sweep(), []);
  assert.equal(p.comments.length, 1);
  assert.match(
    p.logs.at(-1),
    /org\/a#1: skipped, its label couldn't be taken off when it was picked/,
  );
  // Labelled again (and GitHub takes labels off again): picked.
  p.stuck = [];
  p.events["org/a#1"] = [labelled("alice"), labelled("bob", "User", "2026-03-01T00:00:00Z")];
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
  assert.equal(p.accepted[0].author, "bob");
});

test("issues no longer labelled are forgotten: a new labelling of them is told again", async () => {
  const issues = [issue(1, 1)];
  const { pickup, p } = setup({
    repos: { "org/a": { issues } },
    events: { "org/a#1": [labelled("mallory")] },
  });
  await pickup.sweep();
  assert.equal(p.comments.length, 1);
  // The label off: it leaves the list, and what was kept of it goes.
  issues.length = 0;
  await pickup.sweep();
  // Back with the same labelling: read again, its comment's marker not there in this fake.
  issues.push(issue(1, 1));
  await pickup.sweep();
  assert.equal(p.comments.length, 2);
  assert.equal(p.calls.filter((c) => c.includes("/issues/1/events")).length, 2);
});

test("the App's comment refused: the label stays, nothing starts, the next sweep picks it", async () => {
  const { pickup, p } = setup({ repos: { "org/a": { issues: [issue(1, 1)] } }, replyFails: true });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(p.removed, []);
  assert.deepEqual(p.accepted, []);
  assert.match(p.logs.at(-1), /org\/a#1: GitHub refused the reply/);
  // Its labeller is still the one who added it: nothing of the App's in between.
  p.replyFails = false;
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
  assert.equal(p.accepted[0].author, "alice");
});

test("a held labelling is told once, a restarted listener included; a new labelling again", async () => {
  const issues = [issue(1, 1)];
  const marker = `<!-- deckhand:auto-pickup-held ${Date.parse("2026-02-01T00:00:00Z")} -->`;
  // A listener that already said so before a restart: its comment is there.
  const restarted = setup({
    repos: { "org/a": { issues } },
    events: { "org/a#1": [labelled("mallory")] },
    comments: {
      "org/a#1": [{ user: { login: BOT }, body: `Not picked automatically: …\n\n${marker}` }],
    },
  });
  await restarted.pickup.sweep();
  assert.deepEqual(restarted.p.comments, []);
  // The marker in someone else's comment silences nothing: anyone may post it.
  const forged = setup({
    repos: { "org/a": { issues } },
    events: { "org/a#1": [labelled("mallory")] },
    comments: { "org/a#1": [{ user: { login: "mallory" }, body: marker }] },
  });
  await forged.pickup.sweep();
  assert.equal(forged.p.comments.length, 1);

  const { pickup, p } = setup({
    repos: { "org/a": { issues } },
    events: { "org/a#1": [labelled("mallory")] },
  });
  await pickup.sweep();
  assert.equal(p.comments.length, 1);
  // Labelled again, by mallory still, later: the issue changed, and it is a new labelling.
  p.events["org/a#1"] = [labelled("mallory"), labelled("mallory", "User", "2026-03-01T00:00:00Z")];
  issues[0] = { ...issues[0], updated_at: "2026-03-01T00:00:00Z" };
  await pickup.sweep();
  assert.equal(p.comments.length, 2);
  assert.match(
    p.comments[1][1],
    new RegExp(`auto-pickup-held ${Date.parse("2026-03-01T00:00:00Z")}`),
  );
});

test("queueing that fails: the comment says nothing started", async () => {
  const { pickup, p } = setup({ repos: { "org/a": { issues: [issue(1, 1)] } }, acceptFails: true });
  assert.deepEqual(await pickup.sweep(), []);
  assert.match(p.edited[0][1], /not started, it couldn't be queued/);
  assert.match(p.logs.at(-1), /the queue is down/);
});

test("a title or description changed after the label by someone not allowed holds the issue", async () => {
  const renamed = (login, at) => ({
    event: "renamed",
    actor: { login, type: "User" },
    created_at: at,
  });
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [1, 2, 3, 4, 5, 6].map((n) => issue(n, n)) } },
    events: {
      // Renamed by an outsider after the label; before it, by an outsider; after, by bob.
      "org/a#1": [labelled("alice"), renamed("mallory", "2026-03-01T00:00:00Z")],
      "org/a#2": [renamed("mallory", "2026-01-15T00:00:00Z"), labelled("alice")],
      "org/a#3": [labelled("alice"), renamed("bob", "2026-03-01T00:00:00Z")],
    },
    edits: {
      // Edited after the label by an outsider, by the App's bot, by an allowed user.
      "org/a#4": [["2026-03-01T00:00:00Z", "mallory"]],
      "org/a#5": [["2026-03-01T00:00:00Z", BOT, "Bot"]],
      "org/a#6": [["2026-03-01T00:00:00Z", "carol"]],
    },
    env: { MAX_PARALLEL: "5", AUTO_PICKUP_SLOTS: "4" },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#2", "org/a#3", "org/a#6"]);
  assert.deepEqual(
    p.logs.filter((l) => l.includes("skipped")),
    [
      "Auto-pickup: org/a#1: skipped, its title was changed by mallory after the label was added",
      "Auto-pickup: org/a#4: skipped, its description was edited by mallory after the label was added",
      `Auto-pickup: org/a#5: skipped, its description was edited by ${BOT} after the label was added`,
    ],
  );
});

test("every edit since the label counts, not the last one; an edit history too long to read holds it", async () => {
  const outsiderThenAllowed = [
    // Its creation, before the label: an outsider's issue.
    ["2026-01-01T00:00:00Z", "mallory"],
    ["2026-03-01T00:00:00Z", "mallory"],
    ["2026-03-02T00:00:00Z", "carol"],
  ];
  // Older edits not read, all those read after the label; or read back to before it.
  const unread = Object.assign([["2026-03-01T00:00:00Z", "carol"]], { more: true });
  const readBack = Object.assign(
    [
      ["2026-01-15T00:00:00Z", "mallory"],
      ["2026-03-01T00:00:00Z", "carol"],
    ],
    { more: true },
  );
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [1, 2, 3, 4].map((n) => issue(n, n)) } },
    edits: {
      "org/a#1": outsiderThenAllowed,
      "org/a#2": unread,
      "org/a#3": readBack,
      // In the label's own second.
      "org/a#4": [["2026-02-01T00:00:00Z", "mallory"]],
    },
    env: { MAX_PARALLEL: "5", AUTO_PICKUP_SLOTS: "4" },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#3"]);
  assert.deepEqual(
    p.logs.filter((l) => l.includes("skipped")),
    [
      "Auto-pickup: org/a#1: skipped, its description was edited by mallory after the label was added",
      "Auto-pickup: org/a#2: skipped, its description has more edits since the label than can be checked",
      "Auto-pickup: org/a#4: skipped, its description was edited by mallory after the label was added",
    ],
  );
});

test("over 100 edits, whichever end GitHub lists: the issue's last edit since the label holds it", async () => {
  // The oldest 100 read (were GitHub to list them newest first), all before the label.
  const before = Array.from({ length: 100 }, (_, i) => [
    `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    "mallory",
  ]);
  const outsiderLast = Object.assign([...before], {
    more: true,
    last: ["2026-03-01T00:00:00Z", "mallory"],
  });
  // The last edit an allowed user's, but those between it and the page not read.
  const allowedLast = Object.assign([...before], {
    more: true,
    last: ["2026-03-02T00:00:00Z", "carol"],
  });
  // The page reaches the last edit, and goes back to before the label: all known since it.
  const reachesLast = Object.assign([...before, ["2026-03-02T00:00:00Z", "carol"]], {
    more: true,
  });
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [1, 2, 3].map((n) => issue(n, n)) } },
    edits: { "org/a#1": outsiderLast, "org/a#2": allowedLast, "org/a#3": reachesLast },
    env: { MAX_PARALLEL: "5", AUTO_PICKUP_SLOTS: "4" },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#3"]);
  assert.deepEqual(
    p.logs.filter((l) => l.includes("skipped")),
    [
      "Auto-pickup: org/a#1: skipped, its description was edited by mallory after the label was added",
      "Auto-pickup: org/a#2: skipped, its description has more edits since the label than can be checked",
    ],
  );
});

test("an issue a person started while its checks were read isn't picked: no comment, theirs alone", async () => {
  let looks = 0;
  // The sweep's look: nothing live; start()'s, just before the comment: started.
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [issue(1, 1)] } },
    liveNow: () => {
      const now = ++looks;
      return () => now > 1;
    },
  });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(p.comments, []);
  assert.deepEqual(p.accepted, []);
  assert.deepEqual(p.removed, []);
  assert.match(p.logs.at(-1), /org\/a#1: not picked, it started meanwhile/);
});

test("a sweep asked for during another runs once after it", async () => {
  const { pickup, p } = setup({ repos: { "org/a": { issues: [] } } });
  const first = pickup.sweep();
  pickup.sweep();
  pickup.sweep();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.calls.filter((c) => c.startsWith("GET /repos/org/a/issues?")).length, 2);
});

test("labeller(): the last to add the label; bots by their type or their login", () => {
  assert.deepEqual(labeller([labelled("alice"), labelled("bob")], "Auto-Pickup"), {
    login: "bob",
    bot: false,
    at: Date.parse("2026-02-01T00:00:00Z"),
  });
  assert.equal(labeller([labelled("dependabot[bot]")], "auto-pickup").bot, true);
  assert.equal(labeller([{ ...labelled("x"), label: { name: "bug" } }], "auto-pickup"), null);
  // Its last event for the label took it off: the labelling that put it back isn't there.
  const off = { event: "unlabeled", label: { name: "auto-pickup" }, actor: { login: "bob" } };
  assert.equal(labeller([labelled("alice"), off], "auto-pickup"), null);
  assert.equal(labeller([labelled("alice"), off, labelled("bob")], "auto-pickup").login, "bob");
  const config = testConfig({ ALLOWED_USERS: "alice,bob" });
  assert.equal(labellerRefusal({ login: "Alice", bot: false }, config, ["alice"]), null);
  assert.match(labellerRefusal({ login: "bob", bot: false }, config, ["alice"]), /allowed user/);
});

test("pulledIssues(): Deckhand's pull requests from the repo's branches, by their Closes or branch", () => {
  const pr = (body, ref, extra = {}) => ({
    user: { login: BOT },
    body,
    head: { ref, repo: { full_name: "org/a" } },
    ...extra,
  });
  const found = pulledIssues(
    [
      pr("Closes #3", "issue-3-x"),
      pr("", "issue-12-y"),
      pr("Closes #4", "issue-4-x", { head: { ref: "issue-4-x", repo: { full_name: "fork/a" } } }),
      pr("Closes #5", "x", { user: { login: "bob" } }),
    ],
    "org/a",
    BOT,
  );
  assert.deepEqual([...found].sort(), [12, 3]);
});

test("labelAdded(): the configured label's `labeled` delivery, with slots", () => {
  const config = testConfig({ MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: "1" });
  const payload = { action: "labeled", label: { name: "auto-pickup" } };
  assert.equal(labelAdded(config, "issues", payload), true);
  assert.equal(labelAdded(config, "issues", { ...payload, action: "unlabeled" }), false);
  assert.equal(labelAdded(config, "issues", { ...payload, label: { name: "bug" } }), false);
  assert.equal(labelAdded(testConfig(), "issues", payload), false);
});

test("AUTO_PICKUP_SLOTS: off by default, below MAX_PARALLEL", () => {
  const config = testConfig();
  assert.equal(config.autoPickupSlots, 0);
  assert.equal(config.autoPickupLabel, "auto-pickup");
  assert.equal(testConfig({ MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: "2" }).autoPickupSlots, 2);
  for (const slots of ["3", "4"]) {
    assert.throws(
      () => loadConfig({ ALLOWED_USERS: "a", MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: slots }),
      (error) => error instanceof ConfigError && /below MAX_PARALLEL/.test(error.message),
    );
  }
});

test("auto_pickup: off by default, a boolean, a warning without the operator's slots", () => {
  const config = testConfig({ MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: "1" });
  assert.equal(parseRepoConfig("", config).settings.autoPickup, false);
  assert.equal(parseRepoConfig("auto_pickup: true", config).settings.autoPickup, true);
  assert.deepEqual(parseRepoConfig("auto_pickup: yes please", config).errors, [
    "auto_pickup: expected true or false",
  ]);
  const off = parseRepoConfig("auto_pickup: true", testConfig());
  assert.deepEqual(off.warnings, [
    "auto_pickup: the operator reserves no slots for it (AUTO_PICKUP_SLOTS), ignored",
  ]);
});

test("startable() with reserved slots: auto-picked tasks in them only, the others borrowing them while none waits", () => {
  const task = (repo, auto = false, cap = 3) => ({ repo, auto, settings: { maxParallel: cap } });
  const picked = (t) => t.auto;
  const ids = (list) => list.map((t) => `${t.repo}${t.auto ? "*" : ""}`);
  const options = (extra) => ({ reserved: 1, picked, ...extra });
  // None waits: three triggered runs.
  const triggered = [task("org/a"), task("org/b"), task("org/c")];
  assert.deepEqual(ids(startable(triggered, new Map(), 0, 3, options())), [
    "org/a",
    "org/b",
    "org/c",
  ]);
  // Two auto-picked tasks wait: one in the reserved slot, the others keep to 2.
  const mixed = [task("org/a"), task("org/b", true), task("org/c"), task("org/d", true)];
  assert.deepEqual(
    ids(startable(mixed, new Map(), 0, 3, options({ waiting: mixed.filter(picked) }))),
    ["org/b*", "org/a", "org/c"],
  );
  // The reserved slot is held already: no auto-picked one starts; one waiting keeps the
  // triggered ones to 2, counting those running.
  assert.deepEqual(
    ids(
      startable(
        mixed,
        new Map([["org/x", 2]]),
        2,
        3,
        options({ auto: 1, waiting: mixed.filter(picked) }),
      ),
    ),
    ["org/a"],
  );
  // A repo's max_parallel counts auto-picked runs too. One it holds back doesn't wait for a
  // slot: the others take the reserved one meanwhile, rather than leave it idle.
  const capped = [task("org/a", true, 1), task("org/b"), task("org/c")];
  assert.deepEqual(
    ids(startable(capped, new Map([["org/a", 1]]), 1, 3, options({ waiting: [capped[0]] }))),
    ["org/b", "org/c"],
  );
});

test("a repo at its max_parallel: its issues aren't picked, another repo's are", async () => {
  const loads = { "org/a": 1, "org/b": 0 };
  const { pickup, p } = setup({
    repos: {
      "org/a": { issues: [issue(1, 1)], settings: "auto_pickup: true\nmax_parallel: 1" },
      "org/b": { issues: [issue(2, 2)] },
    },
    load: (repo) => loads[repo],
  });
  assert.deepEqual(await pickup.sweep(), ["org/b#2"]);
  assert.match(p.logs[0], /org\/a#1: skipped, its repository's runs are at its max_parallel/);
});

// One of org/a's open pull requests for issue `n`: Deckhand's from its branch unless `extra` says.
const pull = (n, extra = {}) => ({
  number: 100 + n,
  user: { login: BOT },
  draft: false,
  body: `Closes #${n}`,
  head: { ref: `issue-${n}-x`, repo: { full_name: "org/a" } },
  ...extra,
});
const MAX_READY = "auto_pickup: true\nauto_pickup_max_ready: 3";

test("auto_pickup_max_ready: at the limit, no issue of the repo is picked, its label kept, nothing said", async () => {
  const pulls = [pull(10), pull(11), pull(12)];
  const { pickup, p } = setup({
    env: { AUTO_PICKUP_SLOTS: "2" },
    repos: { "org/a": { issues: [issue(1, 1), issue(2, 2)], pulls, settings: MAX_READY } },
  });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(p.comments, []);
  assert.deepEqual(p.removed, []);
  assert.deepEqual(p.accepted, []);
  const why =
    "skipped, its repository has 3 pull requests ready for review (auto_pickup_max_ready: 3)";
  assert.deepEqual(p.logs, [`Auto-pickup: org/a#1: ${why}`, `Auto-pickup: org/a#2: ${why}`]);
  // No events or edits read for it: the brake comes before them.
  assert.equal(p.calls.filter((c) => c.includes("/events")).length, 0);
  // Logged once while it lasts.
  await pickup.sweep();
  assert.equal(p.logs.length, 2);
});

test("auto_pickup_max_ready: below it, or with a draft or a person's pull request among them, picked as today", async () => {
  const cases = {
    two: [pull(10), pull(11)],
    draft: [pull(10), pull(11), pull(12, { draft: true })],
    person: [pull(10), pull(11), pull(12, { user: { login: "bob" } })],
    fork: [pull(10), pull(11), pull(12, { head: { ref: "x", repo: { full_name: "bob/a" } } })],
  };
  for (const [name, pulls] of Object.entries(cases)) {
    const { pickup } = setup({
      repos: { "org/a": { issues: [issue(1, 1)], pulls, settings: MAX_READY } },
    });
    assert.deepEqual(await pickup.sweep(), ["org/a#1"], name);
  }
});

test("auto_pickup_max_ready: a repo at its limit leaves the slot to another opted-in repo", async () => {
  const { pickup } = setup({
    repos: {
      "org/a": {
        issues: [issue(1, 1)],
        pulls: [pull(10), pull(11), pull(12)],
        settings: MAX_READY,
      },
      "org/b": { issues: [issue(2, 2)] },
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/b#2"]);
});

test("auto_pickup_max_ready: no more GitHub calls than without it", async () => {
  const calls = async (settings, pulls) => {
    const { pickup, p } = setup({ repos: { "org/a": { issues: [issue(1, 1)], pulls, settings } } });
    const started = await pickup.sweep();
    return { started, calls: p.calls };
  };
  const pulls = [pull(10), pull(11)];
  const unset = await calls("auto_pickup: true", pulls);
  assert.deepEqual(await calls(MAX_READY, pulls), unset);
  // At the limit: fewer, the brake comes before the issue's events and edits.
  const held = await calls(MAX_READY, [...pulls, pull(12)]);
  assert.deepEqual(held.started, []);
  assert.ok(held.calls.length < unset.calls.length);
  assert.equal(held.calls.filter((c) => c.includes("/pulls")).length, 1);
});

test("auto_pickup_max_ready: a merge brings the count below it, the next sweep picks", async () => {
  const pulls = [pull(10), pull(11), pull(12)];
  const repos = { "org/a": { issues: [issue(1, 1)], pulls, settings: MAX_READY } };
  const timers = [];
  const later = (fn, ms) => (timers.push({ fn, ms }), { unref() {} });
  const { pickup, config } = setup({ repos, later });
  assert.deepEqual(await pickup.sweep(), []);
  const merged = pulls.pop();
  const payload = {
    action: "closed",
    pull_request: { ...merged, merged: true },
    repository: { full_name: "org/a" },
  };
  assert.equal(pullClosed(config, "pull_request", payload), true);
  pickup.soon();
  assert.equal(timers[0].ms, SOON_MS);
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
});

test("pullClosed(): Deckhand's pull request closed or turned to a draft, with slots", () => {
  const config = testConfig({ MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: "1" });
  config.bot = BOT;
  const payload = { action: "closed", pull_request: pull(1), repository: { full_name: "org/a" } };
  assert.equal(pullClosed(config, "pull_request", payload), true);
  assert.equal(
    pullClosed(config, "pull_request", { ...payload, action: "converted_to_draft" }),
    true,
  );
  assert.equal(pullClosed(config, "pull_request", { ...payload, action: "opened" }), false);
  assert.equal(pullClosed(config, "issues", payload), false);
  const person = { ...payload, pull_request: pull(1, { user: { login: "bob" } }) };
  assert.equal(pullClosed(config, "pull_request", person), false);
  const fork = pull(1, { head: { ref: "issue-1-x", repo: { full_name: "bob/a" } } });
  assert.equal(pullClosed(config, "pull_request", { ...payload, pull_request: fork }), false);
  const none = testConfig();
  none.bot = BOT;
  assert.equal(pullClosed(none, "pull_request", payload), false);
});

test("readyPulls(): Deckhand's open pull requests from the repo's branches, not drafts", () => {
  const pulls = [
    pull(1),
    pull(2, { draft: true }),
    pull(3, { user: { login: "bob" } }),
    pull(4, { head: { ref: "issue-4-x", repo: { full_name: "bob/a" } } }),
    pull(5),
  ];
  assert.equal(readyPulls(pulls, "org/a", BOT), 2);
  assert.equal(readyPulls(pulls, "org/a", null), 0);
});

test("auto_pickup_max_ready: a whole number above 0, unset by default, a warning without auto_pickup", () => {
  const config = testConfig({ MAX_PARALLEL: "3", AUTO_PICKUP_SLOTS: "1" });
  assert.equal(parseRepoConfig("", config).settings.autoPickupMaxReady, null);
  const set = parseRepoConfig(MAX_READY, config);
  assert.equal(set.settings.autoPickupMaxReady, 3);
  assert.deepEqual(set.warnings, []);
  for (const bad of ["0", "-1", "2.5", "lots", "true"]) {
    assert.deepEqual(
      parseRepoConfig(`auto_pickup: true\nauto_pickup_max_ready: ${bad}`, config).errors,
      ["auto_pickup_max_ready: expected a whole number above 0"],
      bad,
    );
  }
  assert.deepEqual(parseRepoConfig("auto_pickup_max_ready: 2", config).warnings, [
    "auto_pickup_max_ready: needs `auto_pickup: true`, ignored",
  ]);
});

test("a repo whose issue list fails keeps what is known of its issues: a stuck label isn't picked again", async () => {
  const issues = [issue(1, 1)];
  const { pickup, p } = setup({ repos: { "org/a": { issues } }, stuck: ["org/a#1"] });
  await pickup.sweep();
  assert.equal(p.comments.length, 1);
  // GitHub failing: the list too, this sweep.
  p.listFails = true;
  await pickup.sweep();
  p.listFails = false;
  assert.deepEqual(await pickup.sweep(), []);
  assert.equal(p.comments.length, 1);
});

test("soon(): one sweep a moment later for a burst, none without slots", async () => {
  const timers = [];
  const later = (fn, ms) => (timers.push({ fn, ms }), { unref() {} });
  const { pickup, p } = setup({ repos: { "org/a": { issues: [] } }, later });
  pickup.soon();
  pickup.soon();
  pickup.soon();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, SOON_MS);
  assert.deepEqual(p.calls, []);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.calls.filter((c) => c.startsWith("GET /repos/org/a/issues?")).length, 1);
  // Fired: the next one arms a timer again.
  pickup.soon();
  assert.equal(timers.length, 2);

  const off = [];
  const none = setup({
    env: { AUTO_PICKUP_SLOTS: "0" },
    repos: { "org/a": { issues: [] } },
    later: (fn) => off.push(fn),
  });
  none.pickup.soon();
  assert.deepEqual(off, []);
});

// createTasks() over org/app's tasks, with MAX_PARALLEL 2 and one reserved slot: `runs`, the
// run records newest first (what a restart keeps); `closed` and `pulls`, task key → how its
// issue closed and its pull request (titles.mjs, pulls.mjs); `reviews`, pull request key
// ("org/app#pr-5", spelled as reviews.json has it) → its review loop's entry (reviews.mjs).
// Nothing starts by itself: the test calls schedule().
// `picks`: picks.mjs's store of ended picks.
function pickTasks({ runs = [], closed = {}, pulls = {}, reviews = {}, picks = null } = {}) {
  const started = [];
  const { settings } = parseRepoConfig("auto_pickup: true\n", testConfig());
  const ctx = {
    config: testConfig({ MAX_PARALLEL: "2", AUTO_PICKUP_SLOTS: "1", DEBOUNCE_MS: "60000" }),
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    issueModes: new Map(),
    brainstorms: { get: () => null, end: () => {} },
    runs,
    running: 0,
    run: (task) => {
      task.running = true;
      ctx.running++;
      started.push(task.id);
    },
    titles: {
      set: () => {},
      closed: (key) => closed[key] ?? null,
      keys: () => Object.keys(closed),
    },
    pulls: { get: (key) => pulls[key] ?? null, keys: () => Object.keys(pulls) },
    reviews: {
      entry: (repo, number) => reviews[`${repo}#pr-${number}`] ?? null,
      keys: () => Object.keys(reviews),
    },
    picks,
    received: () => {},
    answer: async () => {},
    runner: { hasSession: async () => true },
    policies: { decide: async () => ({ applied: false, messages: [] }) },
    github: async () => Response.json({ labels: [], user: { login: "alice" } }),
  };
  const tasks = createTasks(ctx);
  // Queued on org/app#`n` as the review loop (`reason`) or a person's comment queues it.
  const queue = async (n, fields = {}) => {
    const item = {
      repo: "org/app",
      id: String(n),
      kind: "issue",
      number: n,
      replyTo: n,
      base: "main",
      settings,
      text: "",
      ...fields,
    };
    await tasks.accept(item);
    const task = ctx.tasks.get(`org/app#${n}`);
    clearTimeout(task.timer);
    task.ready = true;
    return item;
  };
  const review = (n) => queue(n, { trigger: "review", reason: "review", modeLine: null });
  const comment = (n) => queue(n, { trigger: "work", author: "alice", text: "And the dates." });
  return { ctx, started, ...tasks, queue, review, comment };
}

const pickedRun = (n, fields = {}) => ({
  id: `run-${n}`,
  key: `org/app#${n}`,
  repo: "org/app",
  status: "ok",
  autoPickup: true,
  ...fields,
});

// Issue #1's pull request, open, and its loop waiting for CI: the picked run is over.
const READY = { "org/app#1": { number: 5, state: "ready" } };
const WAITS = { "org/app#pr-5": { ciWaiting: { sha: "abc", since: 1 } } };
const looping = (fields = {}) => ({
  runs: [pickedRun(1)],
  pulls: READY,
  reviews: WAITS,
  ...fields,
});

test("the review loop of an auto-picked issue holds its reserved slot: counted, scheduled there, still the listener's", async () => {
  // The picked run is over (its record is all there is, as after a restart); its review is
  // queued after a person's comment on another issue, which waits for a standard slot.
  const p = pickTasks(looping());
  const busy = newTask({ repo: "org/app", id: "9", kind: "issue", number: 9 });
  busy.running = true;
  p.ctx.tasks.set("org/app#9", busy);
  p.ctx.running = 1;
  const other = await p.comment(2);
  const loop = await p.review(1);
  assert.equal(other.autoPickup, undefined);
  assert.deepEqual([loop.autoPickup, loop.followsPick], [true, true]);
  assert.ok(pickedTask(p.ctx.tasks.get("org/app#1")));
  // The slot is taken: the sweep picks nothing for it.
  assert.equal(p.pickedCount(), 1);
  p.schedule();
  // The reserved slot is the review's, though #2 was queued first; #2 waits for a standard one.
  assert.deepEqual(p.started, ["1"]);
  assert.equal(p.pickedCount(), 1);
});

test("a person's comment on an auto-picked task holds the slot too, started by the comment for the policies", async () => {
  const p = pickTasks();
  const picked = await p.queue(1, { trigger: "work", author: "alice", autoPickup: true });
  // Queued behind the picked item, before it ran.
  const follow = await p.comment(1);
  assert.equal(runTrigger(picked), "auto-pickup");
  assert.deepEqual([follow.autoPickup, follow.followsPick], [true, true]);
  assert.equal(runTrigger(follow), "comment");
  // Its run going: what comes then follows it too.
  const task = p.ctx.tasks.get("org/app#1");
  task.pending = [];
  task.live = { record: { autoPickup: true } };
  task.running = true;
  assert.equal((await p.review(1)).autoPickup, true);
  // As do the loop's steps being decided (`deciding`: a webhook's review, a CI decision).
  for (const deciding of ["review", "ci"]) {
    const decided = pickTasks(looping({ reviews: { "org/app#pr-5": { deciding } } }));
    assert.equal((await decided.review(1)).autoPickup, true, deciding);
  }
});

test("a picked run that asked keeps its slot until answered: the answer is the pick's, the sweep picks nothing", async () => {
  for (const pulls of [{}, { "org/app#1": { number: 5, state: "draft" } }]) {
    const asked = [pickedRun(1, { status: "needs-input" })];
    const p = pickTasks({ runs: asked, pulls });
    // After a restart too: the task isn't in `tasks`, its record finds it.
    assert.equal(p.pickedCount(), 1);
    p.ctx.tasks.set("org/app#1", newTask({ repo: "org/app", id: "1", kind: "issue", number: 1 }));
    assert.equal(p.pickedCount(), 1);
    const { pickup } = setup({
      repos: { "org/a": { issues: [issue(2, 1)] } },
      taken: p.pickedCount(),
    });
    assert.deepEqual(await pickup.sweep(), []);
    // The answer runs in the reserved slot, as the pick's.
    const answer = await p.comment(1);
    assert.deepEqual([answer.autoPickup, answer.followsPick], [true, true]);
    p.schedule();
    assert.deepEqual(p.started, ["1"]);
    // Its questions set aside (the label taken off, dismissals.mjs): the slot is free.
    const aside = pickTasks({ runs: asked, pulls });
    aside.ctx.dismissals = { has: (key, runId) => key === "org/app#1" && runId === "run-1" };
    assert.equal(aside.pickedCount(), 0);
    assert.equal((await aside.comment(1)).autoPickup, undefined);
  }
});

test("once the picked work is done, its loop over, or another run came last, what is queued isn't auto-picked", async (t) => {
  const cases = [
    // The issue closed, its pull request merged or closed.
    looping({ closed: { "org/app#1": "completed" } }),
    looping({ pulls: { "org/app#1": { number: 5, state: "merged" } } }),
    looping({ pulls: { "org/app#1": { number: 5, state: "closed" } } }),
    // Merged, or the issue closed, under another spelling of the key.
    looping({ pulls: { "Org/App#1": { number: 5, state: "merged" } } }),
    looping({ closed: { "Org/App#1": "completed" } }),
    // No pull request: the picked run answered, failed, was stopped, or its pull request is a
    // task of its own (it doesn't close the issue).
    looping({ pulls: {} }),
    looping({ runs: [pickedRun(1, { status: "error" })], pulls: {} }),
    looping({ runs: [pickedRun(1, { status: "cancelled" })], pulls: {} }),
    // Its loop over: a clean review, or none ever started (a draft left).
    looping({ reviews: { "org/app#pr-5": { rounds: [{ round: 0 }] } } }),
    looping({ reviews: {}, pulls: { "org/app#1": { number: 5, state: "draft" } } }),
    // Its last run wasn't picked (an earlier one was), or another task's was.
    looping({ runs: [pickedRun(1, { id: "run-2", autoPickup: undefined }), pickedRun(1)] }),
    looping({ runs: [pickedRun(3)] }),
  ];
  for (const state of cases) {
    const p = pickTasks(state);
    const loop = await p.review(1);
    assert.equal(loop.autoPickup, undefined, JSON.stringify(state));
    assert.equal(p.pickedCount(), 0);
  }
  // Closed, then reopened with no run between, its pull request reopened in its loop: the close
  // ended the pick for good.
  const maps = mapStore();
  const picks = createPicks({ ended: await maps.map("picks") });
  const runs = [pickedRun(1)];
  endPicks(picks, runs, ["Org/App#1", "org/app#pr-5"]);
  // Read back as after a restart.
  const reopened = pickTasks(looping({ picks: createPicks({ ended: await maps.again("picks") }) }));
  assert.equal((await reopened.review(1)).autoPickup, undefined);
  // A run after the close (a new pick): the end was the earlier run's.
  const again = pickTasks(looping({ runs: [pickedRun(1, { id: "run-9" }), ...runs], picks }));
  assert.equal((await again.review(1)).autoPickup, true);
  // Its run's record, its pull request and its loop's entry under other spellings: still picked.
  const p = pickTasks(
    looping({
      runs: [pickedRun(1, { key: "Org/App#1" })],
      reviews: { "Org/App#pr-5": WAITS["org/app#pr-5"] },
    }),
  );
  assert.equal((await p.review(1)).autoPickup, true);
  // A fix run that failed with its loop going: still picked.
  const fix = pickTasks(
    looping({ runs: [pickedRun(1, { status: "error", reason: "review-fix" })] }),
  );
  assert.equal((await fix.review(1)).autoPickup, true);
});

test("between two loop steps of an auto-picked issue, nothing queued, its slot stays taken: the sweep picks nothing", async () => {
  const idle = (p, repo = "org/app") =>
    p.ctx.tasks.set(`${repo}#1`, newTask({ repo, id: "1", kind: "issue", number: 1 }));
  // The picked run is over, its pull request ready, the review waiting for CI.
  const p = pickTasks(looping());
  idle(p);
  assert.equal(p.pickedCount(), 1);
  const { pickup } = setup({
    repos: { "org/a": { issues: [issue(2, 1)] } },
    taken: p.pickedCount(),
  });
  assert.deepEqual(await pickup.sweep(), []);
  // A fix run's end, what follows it being decided (`next`): still taken.
  const next = { rounds: [{ round: 1, blocking: true }], next: "review-fix", nextAt: 5 };
  const fixed = pickTasks(
    looping({
      runs: [pickedRun(1, { reason: "review-fix", startedAt: 10 })],
      reviews: { "org/app#pr-5": next },
    }),
  );
  idle(fixed);
  assert.equal(fixed.pickedCount(), 1);
  // After a restart, the task between its steps isn't in `tasks`: its pull request finds it,
  // once whatever its spelling.
  const restarted = pickTasks(looping());
  assert.equal(restarted.pickedCount(), 1);
  idle(restarted, "Org/App");
  assert.equal(restarted.pickedCount(), 1);
  // The loop over (a clean review), the pull request merged, or the task never picked: free.
  for (const state of [
    looping({ reviews: { "org/app#pr-5": { rounds: [{ round: 0 }] } } }),
    looping({ pulls: { "org/app#1": { number: 5, state: "merged" } } }),
    looping({ runs: [pickedRun(1, { autoPickup: undefined })] }),
  ]) {
    const free = pickTasks(state);
    idle(free);
    assert.equal(free.pickedCount(), 0, JSON.stringify(state));
  }
});

test("a slot the sweep counted free is given up for good: the loop its draft starts later runs in a standard slot", async (t) => {
  const picks = createPicks();
  const draft = { "org/app#1": { number: 5, state: "draft" } };
  const reviews = {};
  const p = pickTasks({ runs: [pickedRun(1)], pulls: draft, reviews, picks });
  // The picked run left a draft, no loop going: its slot is free, and the sweep gives it up
  // before it picks #2.
  assert.equal(p.pickedCount(), 0);
  const released = [];
  const { pickup } = setup({
    repos: { "org/a": { issues: [issue(2, 1)] } },
    taken: p.pickedCount(),
    release: () => (released.push(true), p.releasePicks()),
  });
  assert.equal((await pickup.sweep()).length, 1);
  assert.equal(released.length, 1);
  assert.ok(picks.ended("org/app#1", "run-1"));
  await p.queue(2, { trigger: "work", author: "alice", autoPickup: true });
  p.schedule();
  assert.deepEqual(p.started, ["2"]);
  // The draft marked ready: its review, decided, isn't the pick's, and starts at once.
  draft["org/app#1"].state = "ready";
  reviews["org/app#pr-5"] = { deciding: "review" };
  const review = await p.review(1);
  assert.equal(review.autoPickup, undefined);
  p.schedule();
  assert.deepEqual(p.started, ["2", "1"]);
  // A full sweep gives nothing up, nor one with a free slot and nothing to start: the pick
  // goes on, its loop still the pick's when it starts.
  const full = setup({ taken: 1, release: () => released.push(true) });
  assert.deepEqual(await full.pickup.sweep(), []);
  const none = setup({ repos: { "org/a": { issues: [] } }, release: () => released.push(true) });
  assert.deepEqual(await none.pickup.sweep(), []);
  const skipped = setup({
    repos: { "org/a": { issues: [issue(3, 1)] } },
    live: ["org/a#3"],
    release: () => released.push(true),
  });
  assert.deepEqual(await skipped.pickup.sweep(), []);
  assert.equal(released.length, 1);
});

test("releasePicks(): a pick still holding its slot (queued, running, its loop going) is kept", async (t) => {
  const picks = createPicks();
  const runs = [pickedRun(1), pickedRun(2), pickedRun(3, { status: "needs-input" }), pickedRun(4)];
  const p = pickTasks(looping({ runs, picks }));
  // #1's loop waits for CI; #2 has its picked item queued; #3 waits for an answer; #4 left
  // nothing going: given up.
  await p.queue(2, { trigger: "work", author: "alice", autoPickup: true });
  p.releasePicks();
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => picks.ended(`org/app#${n}`, `run-${n}`)),
    [false, false, false, true],
  );
});

test("picks.mjs prune(): an entry whose run is no longer its task's last goes", async () => {
  const maps = mapStore();
  const picks = createPicks({ ended: await maps.map("picks") });
  picks.end("Org/App#1", "run-1");
  picks.end("org/app#2", "run-2");
  picks.prune([pickedRun(1, { id: "run-7" }), pickedRun(1), pickedRun(2)]);
  const read = createPicks({ ended: await maps.again("picks") });
  assert.deepEqual(
    [read.ended("org/app#1", "run-1"), read.ended("org/app#2", "run-2")],
    [false, true],
  );
});

test("a follow-up the App labelled for its merger (#677): picked as theirs; the App's other labellings refused", async () => {
  const at = "2026-02-01T00:00:00Z";
  const asked = [];
  // The reviews' records: #1 for bob, #3 for mallory, #4 for alice, #5 for renovate's labelling.
  const records = { 1: "bob", 3: "mallory", 4: "alice", 5: "alice" };
  const { pickup, p } = setup({
    env: { MAX_PARALLEL: "5", AUTO_PICKUP_SLOTS: "4" },
    repos: { "org/a": { issues: [1, 2, 3, 4, 5].map((n) => issue(n, n)) } },
    events: {
      "org/a#1": [labelled(BOT, "Bot", at)],
      // A run's write: no record.
      "org/a#2": [labelled(BOT, "Bot", at)],
      "org/a#3": [labelled(BOT, "Bot", at)],
      "org/a#4": [labelled(BOT, "Bot", at)],
      // Another bot's labelling: never the reviews' to vouch for.
      "org/a#5": [labelled("renovate[bot]", "Bot", at)],
    },
    // Edited after it was filed by someone not allowed.
    edits: { "org/a#4": [["2026-03-01T00:00:00Z", "mallory"]] },
    followUpPick: (repo, number, when) => {
      asked.push([repo, number, when]);
      return records[number] && number !== 2 ? { by: records[number], pr: 9 } : null;
    },
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
  // Asked for the App's labellings only, with the label's time.
  assert.deepEqual(
    asked.map(([repo, n, when]) => [repo, n, when === Date.parse(at)]),
    [
      ["org/a", 1, true],
      ["org/a", 2, true],
      ["org/a", 3, true],
      ["org/a", 4, true],
    ],
  );
  const [item] = p.accepted;
  assert.equal(item.number, 1);
  assert.equal(item.author, "bob");
  assert.equal(runTrigger(item), "auto-pickup");
  assert.deepEqual(p.removed, ["org/a#1"]);
  const picked = p.comments.find(([key]) => key === "org/a#1")[1];
  assert.match(
    picked,
    /^Picked automatically: the `auto-pickup` label was added by Deckhand for a follow-up of #9, merged by @bob, who the run is for\./,
  );
  assert.deepEqual(
    p.logs.filter((l) => l.includes("skipped")),
    [
      `Auto-pickup: org/a#2: skipped, the label was added by a bot (${BOT})`,
      "Auto-pickup: org/a#3: skipped, the label was added by Deckhand for a follow-up of #9, merged by mallory, who isn't an allowed user",
      "Auto-pickup: org/a#4: skipped, its description was edited by mallory after the label was added",
      "Auto-pickup: org/a#5: skipped, the label was added by a bot (renovate[bot])",
    ],
  );
  // The App's labelling without a record says so on the issue, as any bot's.
  assert.match(
    p.comments.find(([key]) => key === "org/a#2")[1],
    /^Not picked automatically: the label was added by a bot \(deckhand\[bot\]\)\./,
  );
});

test("a follow-up's merger no longer in the repo's users: refused, as a person's label", async () => {
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [issue(1, 1)], settings: "auto_pickup: true\nusers: [alice]" } },
    events: { "org/a#1": [labelled(BOT, "Bot")] },
    followUpPick: () => ({ by: "bob", pr: 9 }),
  });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual(p.accepted, []);
  assert.match(p.comments[0][1], /merged by bob, who isn't an allowed user/);
});

test("vouchedLabeller(): only the App's labelling, only with a record", () => {
  const config = { bot: BOT };
  const pick = () => ({ by: "alice", pr: 3 });
  const app = { login: "Deckhand[bot]", bot: true, at: 5 };
  assert.deepEqual(vouchedLabeller(app, config, pick, "org/a", 1), {
    login: "alice",
    bot: false,
    at: 5,
    pr: 3,
  });
  assert.equal(
    vouchedLabeller(app, config, () => null, "org/a", 1),
    app,
  );
  const other = { login: "renovate[bot]", bot: true, at: 5 };
  assert.equal(vouchedLabeller(other, config, pick, "org/a", 1), other);
  const person = { login: "bob", bot: false, at: 5 };
  assert.equal(vouchedLabeller(person, config, pick, "org/a", 1), person);
  // Before /setup, no App to vouch for.
  assert.equal(vouchedLabeller(app, {}, pick, "org/a", 1), app);
});

test("a follow-up the App filed, edited by an allowed user: the original GitHub lists at its creation is no edit since", async () => {
  const at = "2026-02-01T00:00:00Z";
  const filed = (n) => issue(n, n, { created_at: at });
  const { pickup, p } = setup({
    env: { MAX_PARALLEL: "5", AUTO_PICKUP_SLOTS: "4" },
    repos: { "org/a": { issues: [filed(1), filed(2), filed(3)] } },
    events: {
      "org/a#1": [labelled(BOT, "Bot", at)],
      "org/a#2": [labelled(BOT, "Bot", at)],
      "org/a#3": [labelled("alice", "User", at)],
    },
    // GraphQL names the App's bot without `[bot]`.
    edits: {
      "org/a#1": [
        [at, "deckhand", "Bot"],
        ["2026-02-02T00:00:00Z", "carol"],
      ],
      // A later edit of the App's (a run's write) still holds it.
      "org/a#2": [
        [at, "deckhand", "Bot"],
        ["2026-02-02T00:00:00Z", "deckhand", "Bot"],
      ],
      // Not a follow-up: an edit by the App in the label's second holds it, as before.
      "org/a#3": [[at, "deckhand", "Bot"]],
    },
    followUpPick: (repo, number) => (number < 3 ? { by: "alice", pr: 9 } : null),
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
  assert.deepEqual(
    p.logs.filter((l) => l.includes("skipped")),
    [
      "Auto-pickup: org/a#2: skipped, its description was edited by deckhand after the label was added",
      "Auto-pickup: org/a#3: skipped, its description was edited by deckhand after the label was added",
    ],
  );
});

test("access: the labeller and whoever edited the issue since need runs:start:work", async () => {
  // alice and carol are members of org/a, bob a viewer.
  const permissions = permissionsOf({
    alice: { "org/a": MEMBER },
    bob: { "org/a": VIEWER },
    carol: { "org/a": MEMBER },
  });
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [1, 2, 3, 4].map((n) => issue(n, n)) } },
    events: {
      "org/a#1": [labelled("bob")],
      "org/a#2": [labelled("alice")],
      "org/a#3": [labelled("alice")],
    },
    edits: {
      // Since the label: by a viewer, then by a member.
      "org/a#2": [["2026-03-01T00:00:00Z", "bob"]],
      "org/a#3": [["2026-03-01T00:00:00Z", "carol"]],
    },
    env: { MAX_PARALLEL: "5", AUTO_PICKUP_SLOTS: "4" },
    permissions,
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#3", "org/a#4"]);
  assert.deepEqual(
    p.logs.filter((l) => l.includes("skipped")),
    [
      "Auto-pickup: org/a#1: skipped, the label was added by bob, who may not start work runs here",
      "Auto-pickup: org/a#2: skipped, its description was edited by bob after the label was added",
    ],
  );
  assert.deepEqual(
    p.accepted.map((i) => i.author),
    ["alice", "alice"],
  );
});

test("access: a decision that fails holds nothing and says nothing: the next sweep asks again", async () => {
  const failing = ["alice"];
  const permissions = permissionsOf({ alice: { "org/a": MEMBER } }, { failing });
  const { pickup, p } = setup({ repos: { "org/a": { issues: [issue(1, 1)] } }, permissions });
  assert.deepEqual(await pickup.sweep(), []);
  assert.deepEqual([p.comments, p.removed, p.accepted], [[], [], []]);
  assert.match(
    p.logs.join("\n"),
    /org\/a#1: who has runs:start:work on org\/a can't be decided \(the policies can't be read\)/,
  );
  failing.length = 0;
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
  assert.equal(p.accepted[0].author, "alice");
});

test("access: only the editors since the label are asked about, so an earlier one's failed decision holds nothing", async () => {
  const permissions = permissionsOf({ alice: { "org/a": MEMBER } }, { failing: ["dave"] });
  const { pickup, p } = setup({
    repos: { "org/a": { issues: [issue(1, 1)] } },
    events: { "org/a#1": [labelled("alice")] },
    // dave edited it before the label.
    edits: { "org/a#1": [["2020-01-01T00:00:00Z", "dave"]] },
    env: { ALLOWED_USERS: "alice,dave" },
    permissions,
  });
  assert.deepEqual(await pickup.sweep(), ["org/a#1"]);
  assert.ok(!permissions.asked.some(([login]) => login === "dave"));
});
