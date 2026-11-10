// The work area's fake GitHub and API calls (work.test.mjs, answers-after-review.test.mjs).
import assert from "node:assert/strict";
import { join } from "node:path";
import { ReplyError } from "../listener/comments.mjs";
import { createWaits } from "../listener/waits.mjs";
import { createDismissals } from "../listener/dismissals.mjs";
import { createLanes } from "../listener/lanes.mjs";
import { createOrder } from "../listener/order.mjs";
import { createWorkApi } from "../listener/work.mjs";
import { createAnalysis } from "../listener/analysis.mjs";
import { board as boardOf } from "../listener/board.mjs";
import { parseKey } from "../listener/events.mjs";
import { tempDir, testConfig, fileMap } from "./helpers.mjs";

export const ORIGIN = "https://deckhand.example.com";

// The work area with a fake GitHub behind it: `issues` by number (GET /issues/{n}, the open
// ones listed, and their sub-issues and blockers), `repoSettings` as the default branch's config says, real waits in a temp
// dir.
// `tasks`: the board's, by key (api/state's, with their questions). `events`: an issue's
// timeline, by number. Issues the backlog lists as waiting for input are in `w.listed`, and on
// the board as board.mjs makes them. `queued`: the tasks waiting for a slot that can wait
// instead (runs.mjs queuedTask()), the comment that would wait by key (null: replies only,
// "other": none that starts a run, not replies either: an inbox entry, a wrap-up); busy too.
export function setup({
  env = {},
  settings = {},
  errors = [],
  issues = {},
  busy = [],
  board = [],
  live = board,
  tasks = {},
  runs = {},
  events = {},
  cancels = {},
  queued = {},
  history = [],
  queue = [],
  pulls = {},
  reviews = {},
  // The Map the waits are kept in, else one in a file.
  waits = null,
  // Who may do what where (permissions.mjs); none: every action.
  permissions = null,
} = {}) {
  const config = testConfig({
    ALLOWED_USERS: "alice,bob",
    DATA_DIR: tempDir(null),
    ...env,
  });
  config.bot = "deckhand[bot]";
  const w = {
    calls: [],
    comments: [],
    posted: [],
    accepted: [],
    eyes: [],
    settled: [],
    labels: [],
    untracked: [],
    issues,
    tasks,
    runs,
    events,
    pulls,
    reviews,
    asked: [],
    listed: new Map(),
    cancelled: [],
    unqueued: [],
    queued: { ...queued },
    logs: [],
    created: [],
    clock: 1000,
  };
  let commentId = 500;
  const github = async (repo, method, path, body) => {
    w.calls.push(`${method} ${path}`);
    // A test acts while GitHub is asked (`w.onCall`): a slot freeing, say.
    w.onCall?.(method, path);
    // A test holds GitHub's answers with `w.hold = promise`, or fails them with `w.down`.
    await w.hold;
    if (w.down) return new Response("{}", { status: 502 });
    const on = /\/issues\/(\d+)\/comments$/.exec(path)?.[1];
    if (method === "POST" && on) {
      w.posted.push([Number(on), body.body]);
      return Response.json({ id: ++commentId, html_url: `c/${commentId}`, node_id: "N" });
    }
    if (method === "POST" && path === `/repos/${repo}/labels`) {
      return new Response("{}", { status: w.labelled ? 422 : 201 });
    }
    if (method === "POST" && path === `/repos/${repo}/issues`) {
      if (w.noIssues) return new Response("{}", { status: 410 });
      w.created.push(body);
      const number = 900 + w.created.length;
      return Response.json({ number, title: body.title, html_url: `u/${number}` });
    }
    if (path === `/repos/${repo}`) {
      // GitHub's spelling of the name, whatever the request's (`w.fullName`).
      return repo.toLowerCase() === "org/app"
        ? Response.json({
            full_name: w.fullName ?? "org/app",
            default_branch: "main",
            private: !!w.private,
          })
        : new Response("{}", { status: 404 });
    }
    if (path.startsWith(`/repos/${repo}/issues?`)) {
      return Response.json(
        Object.entries(w.issues)
          .filter(([, i]) => i.state === "open")
          .map(([n, i]) => ({ number: Number(n), html_url: `u/${n}`, ...i })),
      );
    }
    // An issue's sub-issues (`subs`) and blockers (`blockedBy`): numbers of `issues`, or
    // another repo's issues as GitHub describes them.
    const tree = /\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)\?/.exec(path);
    if (tree) {
      const refs =
        (tree[2] === "sub_issues" ? w.issues[tree[1]]?.subs : w.issues[tree[1]]?.blockedBy) ?? [];
      return Response.json(
        refs.map((r) =>
          typeof r === "number"
            ? { number: r, repository_url: `https://api.github.com/repos/${repo}`, ...w.issues[r] }
            : r,
        ),
      );
    }
    // Pull requests (`pulls`) and the reviews on them (`reviews`), by number.
    const pull = /\/pulls\/(\d+)(\/reviews\?.*)?$/.exec(path);
    if (pull) {
      if (pull[2]) return Response.json(path.includes("page=1") ? (w.reviews[pull[1]] ?? []) : []);
      const pr = w.pulls[pull[1]];
      return pr
        ? Response.json({ number: Number(pull[1]), ...pr })
        : new Response("{}", { status: 404 });
    }
    // A comment of the App's edited (`w.edits`: [id, body]).
    const edited = /\/issues\/comments\/(\d+)$/.exec(path)?.[1];
    if (method === "PATCH" && edited) {
      (w.edits ??= []).push([Number(edited), body.body]);
      return Response.json({ id: Number(edited) });
    }
    const timeline = /\/issues\/(\d+)\/events\?/.exec(path)?.[1];
    if (timeline) return Response.json(w.events[timeline] ?? []);
    const n = /\/issues\/(\d+)$/.exec(path)?.[1];
    const issue = w.issues[n];
    return issue
      ? Response.json({ number: Number(n), ...issue })
      : new Response("{}", { status: 404 });
  };
  const reply = async (repo, number, text) => {
    // A test holds the App's comments with `w.replyHold`; `w.replying`: how many wait there.
    if (w.replyHold) {
      w.replying = (w.replying ?? 0) + 1;
      await w.replyHold;
      w.replying--;
    }
    // A test fails a comment with `w.failComment()` returning true: it throws, as comments.mjs's.
    if (w.failComment?.())
      throw new ReplyError(`GitHub POST /repos/${repo}/issues/${number}/comments`, 502);
    w.comments.push([number, text]);
    return Response.json({ id: ++commentId, html_url: `c/${commentId}`, node_id: "N" });
  };
  w.path = join(config.dataDir, "waits.json");
  w.waits = createWaits({
    waits: waits ?? fileMap(w.path),
    github,
    reply,
    received: (i) => w.eyes.push(i.comment.id),
    settle: async (i, status) => w.settled.push([i.comment.id, status]),
    resume: async () => true,
  });
  w.lanes = createLanes({ now: () => w.clock });
  w.dismissals = createDismissals({ now: () => w.clock });
  w.order = createOrder();
  // The tasks waiting for a slot (`queue`: keys, "brainstorm:" before a brainstorm's), as
  // tasks.mjs queueOrder() sorts them.
  w.queue = queue.map((k) => {
    const [mode, key] = k.includes(":") ? k.split(":") : ["work", k];
    const { repo, id } = parseKey(key);
    return { repo, id, pending: [{ mode }] };
  });
  const queueOrder = () => {
    const ranks = w.order.ranks();
    const rank = (t) => ranks.get(`${t.repo}#${t.id}`.toLowerCase()) ?? Infinity;
    return [...w.queue].sort((a, b) => rank(a) - rank(b));
  };
  w.api = createWorkApi({
    config,
    github,
    repoSettings: async () => ({
      settings: { users: config.users, modes: {}, waitForAnswers: true, ...settings },
      errors,
    }),
    reply,
    waits: w.waits,
    // `w.refusing`: what the policies' refusal replied (run-policy.mjs marks the item).
    accept: async (item) => {
      w.accepted.push(item);
      if (w.refusing) item.refused = w.refusing;
      // Its mode, as tasks.mjs accept() says it: none when refused.
      return w.refusing ? null : (item.modeLine ?? "work");
    },
    boardKeys: () => new Set(board),
    liveKeys: () => new Set(live),
    busy: (key) => busy.includes(key) || key in w.queued,
    // `w.started`: its run started (a slot freed): no longer waiting for one.
    queuedTask: (key) => {
      if (w.started || !(key in w.queued)) return null;
      const item = w.queued[key];
      // `w.others`: other authors' comments queued with it.
      return item === "other"
        ? { item: null, replies: false, others: false }
        : { item: item ?? null, replies: item === null, others: !!item && !!w.others };
    },
    // `until`: what the queue keeps them for (restart.mjs park()), in `w.until`; `w.queueIds`:
    // the queueIds it took out.
    unqueue: (key, user, until) => {
      w.unqueued.push([key, user]);
      w.until = until;
      const item = w.queued[key];
      delete w.queued[key];
      // `w.dropped`: other authors' comments queued with it.
      const unqueued = w.queueIds ?? [];
      return item ? { item: { ...item }, dropped: w.dropped ?? 0, unqueued } : null;
    },
    taskOf: (key) =>
      w.tasks[key] ??
      boardOf({
        runs: [],
        queued: [],
        brainstorms: [],
        inputs: [...w.listed].map(([k, questions]) => ({ key: k, since: 1, questions })),
      }).find((t) => t.key === key) ??
      null,
    label: async (repo, number, on) => {
      w.labels.push([number, on]);
      return new Response(null, { status: 200 });
    },
    inputs: {
      set: (key, on, questions) => {
        w.untracked.push([key, on]);
        if (on) w.listed.set(key, questions);
        else w.listed.delete(key);
      },
      has: (key) => w.listed.has(key),
    },
    runOf: (id) => w.runs[id] ?? null,
    cancel: (key, user) => {
      w.cancelled.push([key, user]);
      return cancels[key] ?? null;
    },
    // Each run's digest is its id: the endpoint's checks are what is tested here.
    analysis: createAnalysis({ runs: () => history, partOf: (r) => `part of ${r.id}` }),
    lanes: w.lanes,
    dismissals: w.dismissals,
    order: w.order,
    queueOrder,
    // The review loop's Fix (reviews.mjs startFix(), tested there): what it was asked, and
    // round 4 queued with the App's comment, or `w.noFix`'s reason.
    reviews: {
      fixAsked: async (run, posted, asked) => {
        w.asked.push({ run, posted, user: asked.user });
        if (w.noFix) return { item: null, why: w.noFix };
        const comment = await asked.announce(4, 4, "2 high findings");
        // Refused once its comment is posted (`w.lateFix`): checked again after it; or failing.
        if (w.lateFix) return { item: null, why: w.lateFix };
        if (w.fixFails) throw new Error("GitHub down");
        const item = { reason: "review-fix", round: 4, comment };
        await w.accepted.push(item);
        return { item };
      },
    },
    permissions,
    publicUrl: () => ORIGIN,
    now: () => w.clock,
    log: (line) => w.logs.push(line),
  });
  return w;
}

// A request to the API, with a body for POSTs.
export function call(api, method, url, { user = "alice", origin = ORIGIN, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const listeners = {};
  const req = {
    method,
    url,
    headers: { origin, host: "deckhand.example.com" },
    on(event, fn) {
      listeners[event] = fn;
      if (event === "close") {
        queueMicrotask(() => {
          for (const c of chunks) listeners.data?.(c);
          listeners.end?.();
        });
      }
      return this;
    },
    destroy() {},
  };
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        resolve({ status: this.status, body: JSON.parse(text) });
      },
    };
    assert.equal(api.handle(req, res, user), true);
  });
}

// Lets a background read finish: the fake GitHub answers within a few turns.
export const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

export const post = (w, body, opts = {}) =>
  call(w.api, "POST", "/api/repos/org/app/work", { body, ...opts });

export const open = (title) => ({ state: "open", title });
