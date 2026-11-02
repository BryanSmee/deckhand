import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOON_MS,
  createAutoPickup,
  labelAdded,
  labeller,
  labellerRefusal,
  pulledIssues,
} from "../listener/auto-pickup.mjs";
import { ConfigError, loadConfig } from "../listener/config.mjs";
import { parseRepoConfig, startable } from "../listener/repo-config.mjs";
import { runTrigger } from "../listener/run-policy.mjs";
import { createTasks, newTask, pickedTask } from "../listener/tasks.mjs";
import { testConfig } from "./helpers.mjs";

const BOT = "deckhand[bot]";

// An issue as GitHub lists it: open, labelled auto-pickup, created on day `day`.
const issue = (number, day, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: "open",
  created_at: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
  labels: [{ name: "auto-pickup" }],
  issue_dependencies_summary: { total_blocked_by: 0 },
  updated_at: "2026-02-01T00:00:00Z",
  ...extra,
});

const labelled = (login, type = "User", at = "2026-02-01T00:00:00Z") => ({
  event: "labeled",
  label: { name: "auto-pickup" },
  actor: { login, type },
  created_at: at,
});

// Auto-pickup with a fake GitHub behind it. `repos`: "owner/repo" → { issues, pulls, settings };
// `events`: "owner/repo#n" → the issue's events (alice added the label by default);
// `blockers`: "owner/repo#n" → its "blocked by" issues. `live`: keys with something live, or
// `liveNow()`, the predicate each look builds (a sweep's, start()'s).
// `edits`: "owner/repo#n" → its description's edits, oldest first ([[at, login, type?]], with
// `more: true` for older ones not read), none by default.
// `replyFails`: the App's comment refused (`p.replyFails`, which a test may turn off);
// `acceptFails`: queueing throws. `comments`: "owner/repo#n" → the issue's comments.
// `stuck`: keys whose label can't be taken off (a 500, `p.stuck`).
function setup({
  edits = {},
  replyFails = false,
  acceptFails = false,
  comments = {},
  later = () => null,
  env = {},
  repos = {},
  events = {},
  blockers = {},
  live = [],
  liveNow = () => (key) => live.includes(key),
  taken = 0,
  gone = [],
  stuck = [],
  refuse = false,
  load,
} = {}) {
  const config = testConfig({
    ALLOWED_USERS: "alice,bob,carol",
    MAX_PARALLEL: "3",
    AUTO_PICKUP_SLOTS: "1",
    ...env,
  });
  config.bot = BOT;
  const p = {
    calls: [],
    removed: [],
    comments: [],
    accepted: [],
    logs: [],
    edited: [],
    settingsReads: 0,
    replyFails,
    events,
    stuck,
  };
  const github = async (repo, method, path, body) => {
    p.calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/graphql") {
      const key = `${repo}#${body.variables.number}`;
      // `more`: edits not read, on the page's far side; `last`: the issue's newest edit, the
      // newest read unless the test says.
      const list = edits[key] ?? [];
      const edit = ([editedAt, login, __typename = "User"]) => ({
        editedAt,
        editor: login ? { login, __typename } : null,
      });
      const nodes = list.map(edit);
      const newest = list.last ?? [...list].sort((a, b) => a[0].localeCompare(b[0])).at(-1);
      const userContentEdits = {
        pageInfo: { hasPreviousPage: !!list.more, hasNextPage: false },
        nodes,
      };
      const { editedAt: lastEditedAt = null, editor = null } = newest ? edit(newest) : {};
      return Response.json({
        data: { repository: { issue: { lastEditedAt, editor, userContentEdits } } },
      });
    }
    if (method === "PATCH") {
      p.edited.push([path, body.body]);
      return Response.json({});
    }
    const url = new URL(path, "https://api.github.com");
    const n = /\/issues\/(\d+)\//.exec(url.pathname)?.[1];
    const key = `${repo}#${n}`;
    if (method === "DELETE") {
      if (gone.includes(key)) return new Response("{}", { status: 404 });
      if (p.stuck.includes(key)) return new Response("{}", { status: 500 });
      p.removed.push(key);
      return new Response(null, { status: 200 });
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const list = (items) => Response.json(page === 1 ? items : []);
    if (url.pathname.endsWith("/pulls")) return list(repos[repo].pulls ?? []);
    if (url.pathname === `/repos/${repo}/issues`) {
      if (p.listFails) return new Response("{}", { status: 502 });
      assert.equal(url.searchParams.get("labels"), config.autoPickupLabel);
      return list(repos[repo].issues);
    }
    if (url.pathname.endsWith("/events")) return list(p.events[key] ?? [labelled("alice")]);
    if (url.pathname.endsWith("/comments")) return list(comments[key] ?? []);
    if (url.pathname.endsWith("/dependencies/blocked_by")) return list(blockers[key] ?? []);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const pickup = createAutoPickup({
    config,
    github,
    repos: async () => Object.keys(repos).map((repo) => ({ repo, base: "main" })),
    repoSettings: async (repo) => {
      p.settingsReads++;
      const own = repos[repo].settings ?? "auto_pickup: true";
      return parseRepoConfig(own, config);
    },
    accept: async (item) => {
      p.accepted.push(item);
      if (acceptFails) throw new Error("the queue is down");
      if (refuse) {
        item.refused = "no";
        return null;
      }
      return "work";
    },
    reply: async (repo, number, text) => {
      if (p.replyFails) throw new Error("GitHub refused the reply: 422");
      p.comments.push([`${repo}#${number}`, text]);
      return Response.json({ id: 900 + number, html_url: `c/${number}`, node_id: "N" });
    },
    live: liveNow,
    taken: () => taken,
    load,
    log: (line) => p.logs.push(line),
    every: () => null,
    later,
  });
  return { pickup, p, config };
}

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
// issue closed and its pull request (titles.mjs, pulls.mjs); `reviews`, pull request number →
// its review loop's entry (reviews.mjs). Nothing starts by itself: the test calls schedule().
function pickTasks({ runs = [], closed = {}, pulls = {}, reviews = {} } = {}) {
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
    reviews: { entry: (repo, number) => reviews[number] ?? null },
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

test("the review loop of an auto-picked issue holds its reserved slot: counted, scheduled there, still the listener's", async () => {
  // The picked run is over (its record is all there is, as after a restart); its review is
  // queued after a person's comment on another issue, which waits for a standard slot.
  const p = pickTasks({ runs: [pickedRun(1)] });
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
});

test("once the picked work is done, or another run came last, what is queued isn't auto-picked", async () => {
  const cases = [
    // The issue closed, its pull request merged or closed.
    { runs: [pickedRun(1)], closed: { "org/app#1": "completed" } },
    { runs: [pickedRun(1)], pulls: { "org/app#1": { number: 5, state: "merged" } } },
    { runs: [pickedRun(1)], pulls: { "org/app#1": { number: 5, state: "closed" } } },
    // The picked run failed or was stopped before any pull request.
    { runs: [pickedRun(1, { status: "error" })] },
    { runs: [pickedRun(1, { status: "cancelled" })] },
    { runs: [pickedRun(1, { status: "stopped" })] },
    // Merged, or the issue closed, under another spelling of the key.
    { runs: [pickedRun(1)], pulls: { "Org/App#1": { number: 5, state: "merged" } } },
    { runs: [pickedRun(1)], closed: { "Org/App#1": "completed" } },
    // Its last run wasn't picked (an earlier one was), or another task's was.
    { runs: [pickedRun(1, { id: "run-2", autoPickup: undefined }), pickedRun(1)] },
    { runs: [pickedRun(3)] },
  ];
  for (const state of cases) {
    const p = pickTasks(state);
    const loop = await p.review(1);
    assert.equal(loop.autoPickup, undefined, JSON.stringify(state));
    assert.equal(p.pickedCount(), 0);
  }
  // Its pull request still open, under another spelling of the key: still picked.
  const p = pickTasks({
    runs: [pickedRun(1, { key: "Org/App#1" })],
    pulls: { "org/app#1": { number: 5, state: "ready" } },
  });
  assert.equal((await p.review(1)).autoPickup, true);
  // A fix run that failed with its pull request open: the loop's, still picked.
  const fix = pickTasks({
    runs: [pickedRun(1, { status: "error", reason: "review-fix" })],
    pulls: { "org/app#1": { number: 5, state: "ready" } },
  });
  assert.equal((await fix.review(1)).autoPickup, true);
});

test("between two loop steps of an auto-picked issue, nothing queued, its slot stays taken: the sweep picks nothing", async () => {
  const ready = { "org/app#1": { number: 5, state: "ready" } };
  const waits = { 5: { ciWaiting: { sha: "abc", since: 1 } } };
  // The picked run is over, its pull request ready, the review waiting for CI.
  const p = pickTasks({ runs: [pickedRun(1)], pulls: ready, reviews: waits });
  p.ctx.tasks.set("org/app#1", newTask({ repo: "org/app", id: "1", kind: "issue", number: 1 }));
  assert.equal(p.pickedCount(), 1);
  const { pickup } = setup({
    repos: { "org/a": { issues: [issue(2, 1)] } },
    taken: p.pickedCount(),
  });
  assert.deepEqual(await pickup.sweep(), []);
  // A fix run's end, what follows it being decided (`next`): still taken.
  const fixed = pickTasks({
    runs: [pickedRun(1, { reason: "review-fix", startedAt: 10 })],
    pulls: ready,
    reviews: { 5: { rounds: [{ round: 1, blocking: true }], next: "review-fix", nextAt: 5 } },
  });
  fixed.ctx.tasks.set("org/app#1", newTask({ repo: "org/app", id: "1", kind: "issue", number: 1 }));
  assert.equal(fixed.pickedCount(), 1);
  // The loop over (a clean review), the pull request merged, or the task never picked: free.
  for (const state of [
    { runs: [pickedRun(1)], pulls: ready, reviews: { 5: { rounds: [{ round: 0 }] } } },
    {
      runs: [pickedRun(1)],
      pulls: { "org/app#1": { number: 5, state: "merged" } },
      reviews: waits,
    },
    { runs: [pickedRun(1, { autoPickup: undefined })], pulls: ready, reviews: waits },
  ]) {
    const free = pickTasks(state);
    free.ctx.tasks.set(
      "org/app#1",
      newTask({ repo: "org/app", id: "1", kind: "issue", number: 1 }),
    );
    assert.equal(free.pickedCount(), 0, JSON.stringify(state));
  }
});
