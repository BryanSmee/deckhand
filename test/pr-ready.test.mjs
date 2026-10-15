// Ready for review, or back to draft, from a sandbox: the listener calls the mutation with a
// token the sandbox never sees, for its own repo's pull requests only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { PUSH_PERMISSIONS } from "../listener/github-app.mjs";
import { createPrReady } from "../listener/pr-ready.mjs";

function pull({
  number = 7,
  draft = true,
  base = "org/repo",
  head = base,
  mergeable_state = "clean",
  ref = "issue-1-x",
} = {}) {
  return {
    number,
    draft,
    mergeable_state,
    node_id: `PR_${number}`,
    base: { ref: "main", repo: { full_name: base } },
    head: { ref, repo: head && { full_name: head } },
  };
}

// A work run on issue 1, whose branches are issue-1-*.
function issueRun(broker, repo = "org/repo", branches = ["issue-1-*"]) {
  const secret = broker.register(repo, undefined, { push: true });
  broker.allow(secret, branches);
  return secret;
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
  const secret = issueRun(broker, "Org/Repo");
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
  const res = await post("/pr/Org/Repo/7/draft", issueRun(broker));
  assert.equal(res.status, 200);
  assert.equal(seen.mutations[0].name, "convertPullRequestToDraft");
});

test("a pull request already in that state is left alone", async (t) => {
  const { broker, seen, post, close } = await serve({ pulls: { 7: pull({ draft: false }) } });
  t.after(close);
  const res = await post("/pr/org/repo/7/ready", issueRun(broker));
  assert.deepEqual(res, {
    status: 200,
    body: { message: "org/repo#7 is already ready for review" },
  });
  assert.deepEqual(seen.mutations, []);
});

test("a pull request that conflicts with its base is refused ready, until it is rebased", async (t) => {
  const states = ["clean", "unstable", "blocked", "unknown", "behind", null];
  const pulls = { 7: pull({ mergeable_state: "dirty" }) };
  states.forEach((state, i) => (pulls[20 + i] = pull({ number: 20 + i, mergeable_state: state })));
  const { broker, seen, post, close } = await serve({ pulls });
  t.after(close);
  const secret = issueRun(broker);
  const dirty = await post("/pr/org/repo/7/ready", secret);
  assert.equal(dirty.status, 409);
  assert.match(dirty.body.error, /org\/repo#7 conflicts with main: rebase on origin\/main first/);
  assert.deepEqual(seen.mutations, []);
  for (let i = 0; i < states.length; i++) {
    assert.equal((await post(`/pr/org/repo/${20 + i}/ready`, secret)).status, 200, states[i]);
  }
  assert.equal(seen.mutations.length, states.length);
  // Back to draft is always fine.
  pulls[7].draft = false;
  assert.equal((await post("/pr/org/repo/7/draft", secret)).status, 200);
});

test("unknown or finished runs, other repos and runs that can't write are refused before GitHub", async (t) => {
  const { broker, seen, post, close } = await serve();
  t.after(close);
  const finished = broker.register("org/repo", undefined, { push: true });
  broker.revoke(finished);
  assert.equal((await post("/pr/org/repo/7/ready")).status, 401);
  assert.equal((await post("/pr/org/repo/7/ready", "guess")).status, 401);
  assert.equal((await post("/pr/org/repo/7/ready", finished)).status, 401);
  const other = await post(
    "/pr/org/other/7/ready",
    broker.register("org/repo", undefined, { push: true }),
  );
  assert.equal(other.status, 403);
  assert.match(other.body.error, /only change org\/repo's/);
  // Light runs (brainstorms, inbox entries, onboarding, light modes), whatever their token.
  for (const light of [
    broker.register("org/repo", { pull_requests: "read" }),
    broker.register("org/repo", { pull_requests: "write" }, { push: false }),
  ]) {
    assert.equal((await post("/pr/org/repo/7/ready", light)).status, 403);
    assert.equal((await post("/pr/org/repo/7/draft", light)).status, 403);
  }
  // Wrong method or path.
  const secret = issueRun(broker);
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
  const secret = issueRun(broker);
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
  const res = await failing.post("/pr/org/repo/7/ready", issueRun(failing.broker));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /refused to mark org\/repo#7/);

  const none = await serve({ app: false });
  t.after(none.close);
  assert.equal(
    (
      await none.post(
        "/pr/org/repo/7/ready",
        none.broker.register("org/repo", undefined, { push: true }),
      )
    ).status,
    503,
  );
});

test("only a pull request on one of the run's branches is changed", async (t) => {
  const { broker, seen, post, close } = await serve({
    pulls: {
      7: pull({ ref: "issue-12-x" }),
      8: pull({ number: 8, ref: "issue-13-y" }),
      9: pull({ number: 9, ref: "feature/maintainer" }),
    },
  });
  t.after(close);
  const work = issueRun(broker, "org/repo", ["issue-12-*"]);
  assert.equal((await post("/pr/org/repo/7/ready", work)).status, 200);
  const other = await post("/pr/org/repo/8/ready", work);
  assert.equal(other.status, 403);
  assert.match(other.body.error, /org\/repo#8's branch, issue-13-y, is not this run's/);
  assert.equal((await post("/pr/org/repo/9/ready", work)).status, 403);
  // A pull request's run: its own head only.
  const onPr = issueRun(broker, "org/repo", ["feature/maintainer"]);
  assert.equal((await post("/pr/org/repo/9/ready", onPr)).status, 200);
  assert.equal((await post("/pr/org/repo/7/draft", onPr)).status, 403);
  // A run with no branch at all.
  assert.equal(
    (await post("/pr/org/repo/7/draft", broker.register("org/repo", undefined, { push: true })))
      .status,
    403,
  );
  assert.deepEqual(
    seen.mutations.map((m) => m.id),
    ["PR_7", "PR_9"],
  );
});
