import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PER_PAGE,
  createGitHub,
  fetchTitle,
  getJson,
  graphql,
  graphqlData,
  incidentNote,
  listLabelled,
  paginate,
  rateLimited,
} from "../listener/github.mjs";

// A fake `github(repo, method, path, body, expected)`: `answers` path → Response, the calls kept.
function fake(answers) {
  const calls = [];
  const github = async (repo, method, path, body, expected) => {
    calls.push({ repo, method, path, body, expected });
    const answer = answers[path];
    return typeof answer === "function"
      ? answer(body)
      : (answer ?? new Response("{}", { status: 404 }));
  };
  return { github, calls };
}

test("getJson: the body, null for an expected status, an error for the rest", async () => {
  const { github, calls } = fake({
    "/repos/o/r": Response.json({ default_branch: "trunk" }),
    "/repos/o/r/issues/1": new Response("{}", { status: 410 }),
    "/repos/o/r/issues/2": new Response("{}", { status: 500 }),
  });
  assert.deepEqual(await getJson(github, "o/r", "/repos/o/r"), { default_branch: "trunk" });
  assert.deepEqual(calls[0], {
    repo: "o/r",
    method: "GET",
    path: "/repos/o/r",
    body: undefined,
    expected: [],
  });
  assert.equal(await getJson(github, "o/r", "/repos/o/r/issues/1", [404, 410]), null);
  assert.equal(calls[1].expected.join(), "404,410");
  await assert.rejects(getJson(github, "o/r", "/repos/o/r/issues/2", [404]), {
    message: "GitHub GET /repos/o/r/issues/2: 500",
  });
  // Not expected: an error, not null.
  await assert.rejects(getJson(github, "o/r", "/repos/o/r/issues/1"), /410/);
});

test("paginate: every page until a short one, the entries picked", async () => {
  const asked = [];
  const pages = { 1: PER_PAGE, 2: PER_PAGE, 3: 7 };
  const get = async (path) => {
    asked.push(path);
    const page = Number(/page=(\d+)$/.exec(path)[1]);
    const n = pages[page] ?? 0;
    return Response.json({ repositories: Array.from({ length: n }, (_, i) => `${page}-${i}`) });
  };
  const all = await paginate(get, "/installation/repositories", (body) => body.repositories);
  assert.equal(all.length, 2 * PER_PAGE + 7);
  assert.equal(all.at(-1), "3-6");
  assert.deepEqual(asked, [
    "/installation/repositories?per_page=100&page=1",
    "/installation/repositories?per_page=100&page=2",
    "/installation/repositories?per_page=100&page=3",
  ]);
  // A path with a query already; a page that is the list itself.
  const one = await paginate(async (path) => {
    assert.equal(path, "/repos/o/r/issues/3/events?a=1&per_page=100&page=1");
    return Response.json([{ event: "labeled" }]);
  }, "/repos/o/r/issues/3/events?a=1");
  assert.deepEqual(one, [{ event: "labeled" }]);
  await assert.rejects(
    paginate(async () => new Response("{}", { status: 502 }), "/app/installations"),
    { message: "GitHub GET /app/installations: 502" },
  );
  await assert.rejects(
    paginate(async () => Response.json({ message: "?" }), "/app/installations"),
    /no list/,
  );
});

test("graphql: the data; GraphQL's errors, on a 200, thrown as a failed status is", async () => {
  const { github, calls } = fake({
    "/graphql": ({ query }) =>
      query.includes("bad")
        ? Response.json({ errors: [{ type: "NOT_FOUND" }] })
        : Response.json({ data: { ok: true } }),
  });
  assert.deepEqual(await graphql(github, "o/r", "query { ok }", { a: 1 }), { ok: true });
  assert.deepEqual(calls[0].body, { query: "query { ok }", variables: { a: 1 } });
  assert.equal(calls[0].method, "POST");
  await assert.rejects(graphql(github, "o/r", "query { bad }"), {
    message: 'GraphQL: 200 [{"type":"NOT_FOUND"}]',
  });
  await assert.rejects(graphqlData(new Response("nope", { status: 502 }), "ready"), {
    message: "ready: 502 {}",
  });
});

test("createGitHub: refuses calls until there is an App, then makes them as it", async () => {
  let app = null;
  const { github } = createGitHub(() => app);
  await assert.rejects(github("o/r", "GET", "/repos/o/r"), /not set up/);
  const seen = [];
  app = { request: async (...args) => (seen.push(args), Response.json({})) };
  await github("o/r", "GET", "/repos/o/r", undefined, [404]);
  assert.deepEqual(seen, [["o/r", "GET", "/repos/o/r", undefined, [404]]]);
});

test("fetchTitle: an issue's title and closed state, a discussion's through GraphQL", async () => {
  const { github } = fake({
    "/repos/o/r/issues/3": Response.json({
      title: "Done",
      state: "closed",
      state_reason: "completed",
    }),
    "/repos/o/r/issues/4": new Response("{}", { status: 404 }),
    "/graphql": () => Response.json({ data: { repository: { discussion: { title: "Talk" } } } }),
  });
  assert.deepEqual(await fetchTitle(github, "o/r", "issue", 3), {
    title: "Done",
    closed: "completed",
  });
  assert.equal(await fetchTitle(github, "o/r", "issue", 4), null);
  assert.deepEqual(await fetchTitle(github, "o/r", "discussion", 5), { title: "Talk" });
});

test("listLabelled: every page of open issues with the label, which must be a list", async () => {
  const path = (page) =>
    `/repos/o/r/issues?labels=needs%20input&state=open&sort=updated&per_page=100&page=${page}`;
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 2 }));
  const { github, calls } = fake({
    [path(1)]: Response.json(full),
    [path(2)]: Response.json([{ number: 1 }]),
  });
  const all = await listLabelled(github, "o/r", "needs input");
  assert.deepEqual([all.length, all.at(-1)], [101, { number: 1 }]);
  assert.deepEqual(
    calls.map((c) => c.path),
    [path(1), path(2)],
  );
  const other = fake({ [path(1)]: Response.json({}) });
  await assert.rejects(listLabelled(other.github, "o/r", "needs input"), /no list/);
});

test("rateLimited: a 429, or a 403 saying so by its headers or its body, which stays readable", async () => {
  const answer = (status, headers = {}, body = "{}") => new Response(body, { status, headers });
  assert.equal(await rateLimited(answer(429)), true);
  assert.equal(await rateLimited(answer(403, { "x-ratelimit-remaining": "0" })), true);
  assert.equal(await rateLimited(answer(403, { "retry-after": "30" })), true);
  const secondary = answer(403, {}, '{"message":"You have exceeded a secondary rate limit."}');
  assert.equal(await rateLimited(secondary), true);
  assert.match((await secondary.json()).message, /secondary/);
  assert.equal(await rateLimited(answer(403, { "x-ratelimit-remaining": "12" })), false);
  assert.equal(await rateLimited(answer(403, {}, '{"message":"Resource not accessible"}')), false);
  for (const status of [404, 500, 200]) assert.equal(await rateLimited(answer(status)), false);
});

// The github service's GET /status, read a minute before `now` (#943).
const NOW = 1_800_000_000_000;
const read = (extra = {}) => ({
  watched: true,
  checkedAt: NOW - 60_000,
  indicator: "minor",
  description: "Minor Service Outage",
  incidents: [],
  ...extra,
});

test("incidentNote: GitHub's open incidents, each named, linked in a reply", () => {
  const incidents = [
    {
      name: "Webhooks delayed",
      status: "identified",
      url: "https://www.githubstatus.com/incidents/a1",
    },
    { name: "Git slow", status: "investigating", url: null },
  ];
  assert.equal(
    incidentNote(read({ incidents }), { now: NOW }),
    "GitHub's status page reported 2 open incidents then: “Webhooks delayed” (identified); “Git slow” (investigating).",
  );
  assert.equal(
    incidentNote(read({ incidents }), { now: NOW, links: true }),
    "GitHub's status page reported 2 open incidents then: [Webhooks delayed](https://www.githubstatus.com/incidents/a1) (identified); “Git slow” (investigating).",
  );
});

test("incidentNote: no incident, its indicator's description or nothing to report", () => {
  assert.equal(
    incidentNote(read({ indicator: "none" }), { now: NOW }),
    "GitHub's status page reported no incident then.",
  );
  assert.equal(
    incidentNote(read(), { now: NOW }),
    "GitHub's status page said then: Minor Service Outage.",
  );
});

test("incidentNote: null when the status can't tell about then", () => {
  assert.equal(incidentNote(null, { now: NOW }), null);
  assert.equal(incidentNote({ watched: false }, { now: NOW }), null);
  // Not read yet, or only failed tries.
  assert.equal(incidentNote(read({ indicator: null, checkedAt: null }), { now: NOW }), null);
  // Read too long before.
  assert.equal(incidentNote(read({ checkedAt: NOW - 16 * 60_000 }), { now: NOW }), null);
  assert.ok(incidentNote(read({ checkedAt: NOW - 14 * 60_000 }), { now: NOW }));
});
