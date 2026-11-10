// The fake GitHub behind auto-pickup's tests (auto-pickup.test.mjs, auto-pickup-order.test.mjs).
import assert from "node:assert/strict";
import { createAutoPickup } from "../../listener/auto-pickup.mjs";
import { parseRepoConfig } from "../../listener/repo-config.mjs";
import { testConfig } from "../helpers.mjs";

export const BOT = "deckhand[bot]";

// An issue as GitHub lists it: open, labelled auto-pickup, created on day `day`.
export const issue = (number, day, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  state: "open",
  created_at: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
  labels: [{ name: "auto-pickup" }],
  issue_dependencies_summary: { total_blocked_by: 0 },
  updated_at: "2026-02-01T00:00:00Z",
  ...extra,
});

export const labelled = (login, type = "User", at = "2026-02-01T00:00:00Z") => ({
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
export function setup({
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
  release,
  followUpPick,
  permissions = null,
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
    release,
    load,
    followUpPick,
    permissions,
    log: (line) => p.logs.push(line),
    every: () => null,
    later,
  });
  return { pickup, p, config };
}
