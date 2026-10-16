import assert from "node:assert/strict";
import { test } from "node:test";
import { PER_PAGE, getJson, graphql, graphqlData, paginate } from "../listener/github.mjs";

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
