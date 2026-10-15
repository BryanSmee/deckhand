// Ready for review, or back to draft, from a sandbox: the listener calls the mutation with a
// token the sandbox never sees, for its own repo's pull requests only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { PUSH_PERMISSIONS } from "../listener/github-app.mjs";
import { createPrReady } from "../listener/pr-ready.mjs";

function pull({ number = 7, draft = true, base = "org/repo", head = base } = {}) {
  return {
    number,
    draft,
    node_id: `PR_${number}`,
    base: { repo: { full_name: base } },
    head: { repo: head && { full_name: head } },
  };
}

async function serve({ pulls = { 7: pull() }, app = true, graphql = {} } = {}) {
  const seen = { lookups: [], tokens: [], mutations: [] };
  const github = app && {
    request: async (repo, method, path) => {
      seen.lookups.push(`${method} ${path}`);
      const number = Number(path.split("/").pop());
      const found = pulls[number];
      return found ? Response.json(found) : new Response("{}", { status: 404 });
    },
    repoToken: async (repo, extra) => {
      seen.tokens.push({ repo, extra });
      return { token: "push-token", expiresAt: Date.now() + 3600000 };
    },
  };
  const graphqlFetch = async (url, { headers, body }) => {
    const { query, variables } = JSON.parse(body);
    seen.mutations.push({
      url,
      authorization: headers.authorization,
      name: /\{ (\w+)\(/.exec(query)[1],
      id: variables.id,
    });
    return Response.json(graphql);
  };
  const broker = createBroker({ app: () => github });
  const prReady = createPrReady({
    broker,
    app: () => github,
    api: "https://api.example",
    fetch: graphqlFetch,
  });
  const server = createServer((req, res) => prReady.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, secret, method = "POST") => {
    const res = await fetch(url + path, {
      method,
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    return { status: res.status, body: await res.json() };
  };
  return { broker, seen, post, close: () => server.close() };
}

test("a work run marks its pull request ready, and back to draft, with the gateway's token", async (t) => {
  const { broker, seen, post, close } = await serve();
  t.after(close);
  const secret = broker.register("Org/Repo");
  const ready = await post("/pr/org/repo/7/ready", secret);
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { message: "org/repo#7 is marked as ready for review" });
  assert.deepEqual(seen.lookups, ["GET /repos/org/repo/pulls/7"]);
  assert.deepEqual(seen.tokens, [{ repo: "org/repo", extra: PUSH_PERMISSIONS }]);
  assert.deepEqual(seen.mutations, [
    {
      url: "https://api.example/graphql",
      authorization: "Bearer push-token",
      name: "markPullRequestReadyForReview",
      id: "PR_7",
    },
  ]);
});

test("--undo converts a ready pull request back to draft", async (t) => {
  const { broker, seen, post, close } = await serve({ pulls: { 7: pull({ draft: false }) } });
  t.after(close);
  const res = await post("/pr/Org/Repo/7/draft", broker.register("org/repo"));
  assert.equal(res.status, 200);
  assert.equal(seen.mutations[0].name, "convertPullRequestToDraft");
});

test("a pull request already in that state is left alone", async (t) => {
  const { broker, seen, post, close } = await serve({ pulls: { 7: pull({ draft: false }) } });
  t.after(close);
  const res = await post("/pr/org/repo/7/ready", broker.register("org/repo"));
  assert.deepEqual(res, {
    status: 200,
    body: { message: "org/repo#7 is already ready for review" },
  });
  assert.deepEqual(seen.mutations, []);
});

test("unknown or finished runs, other repos and runs that can't write are refused before GitHub", async (t) => {
  const { broker, seen, post, close } = await serve();
  t.after(close);
  const finished = broker.register("org/repo");
  broker.revoke(finished);
  assert.equal((await post("/pr/org/repo/7/ready")).status, 401);
  assert.equal((await post("/pr/org/repo/7/ready", "guess")).status, 401);
  assert.equal((await post("/pr/org/repo/7/ready", finished)).status, 401);
  const other = await post("/pr/org/other/7/ready", broker.register("org/repo"));
  assert.equal(other.status, 403);
  assert.match(other.body.error, /only change org\/repo's/);
  // Onboarding and light modes: their token can't write pull requests.
  const light = broker.register("org/repo", { pull_requests: "read" });
  assert.equal((await post("/pr/org/repo/7/ready", light)).status, 403);
  assert.equal((await post("/pr/org/repo/7/draft", light)).status, 403);
  // Wrong method or path.
  const secret = broker.register("org/repo");
  assert.equal((await post("/pr/org/repo/7/ready", secret, "GET")).status, 405);
  assert.equal((await post("/pr/org/repo/7/merge", secret)).status, 404);
  assert.deepEqual(seen.lookups, []);
  assert.deepEqual(seen.tokens, []);
  assert.deepEqual(seen.mutations, []);
});

test("a fork's pull request, or one of another base, is never changed", async (t) => {
  const { broker, seen, post, close } = await serve({
    pulls: {
      7: pull({ head: "someone/repo" }),
      8: pull({ number: 8, head: null }),
      9: pull({ number: 9, base: "org/elsewhere" }),
    },
  });
  t.after(close);
  const secret = broker.register("org/repo");
  const fork = await post("/pr/org/repo/7/ready", secret);
  assert.equal(fork.status, 403);
  assert.match(fork.body.error, /fork/);
  assert.equal((await post("/pr/org/repo/8/ready", secret)).status, 403);
  assert.equal((await post("/pr/org/repo/9/ready", secret)).status, 403);
  assert.equal((await post("/pr/org/repo/10/ready", secret)).status, 404);
  assert.deepEqual(seen.tokens, []);
  assert.deepEqual(seen.mutations, []);
});

test("GitHub's GraphQL errors and a missing App are reported", async (t) => {
  const failing = await serve({ graphql: { errors: [{ message: "Resource not accessible" }] } });
  t.after(failing.close);
  const res = await failing.post("/pr/org/repo/7/ready", failing.broker.register("org/repo"));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /refused to mark org\/repo#7/);

  const none = await serve({ app: false });
  t.after(none.close);
  assert.equal(
    (await none.post("/pr/org/repo/7/ready", none.broker.register("org/repo"))).status,
    503,
  );
});
