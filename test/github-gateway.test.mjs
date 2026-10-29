// The GitHub gateway (github-gateway.mjs): a sandbox's GitHub calls, relayed by the egress proxy,
// go on with a token for its run's repo, their writes redacted; nobody else's do.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createBroker } from "../listener/broker.mjs";
import { NO_TOKEN, readsOf } from "../listener/github-app.mjs";
import { createGraphqlChecks } from "../listener/github-graphql.mjs";
import {
  createGithubGateway,
  readsThread,
  redactBody,
  secretOf,
} from "../listener/github-gateway.mjs";
import { sandboxAt, serve } from "./helpers.mjs";

const TOKEN = "repo-token-0123456789abcdef";
const OPERATOR = "operator-key-0123456789abcdef";

// A fake GitHub, on GitHub Enterprise Server's layout (its API under /api/v3, on the web's
// host), and a gateway in front of it. `anonymous`: the run a call without a secret is from.
// `checkWrite`: what the REST writes are held to (github-writes.mjs): here, nothing; null, the
// gateway's own default. `checkGraphql`: the same for GraphQL (github-graphql.mjs): here, its
// body goes on as a read.
async function gateway(
  t,
  {
    sentFrom = sandboxAt(),
    app = true,
    maxInFlight,
    hold,
    checkWrite = async () => null,
    checkGraphql = async (run, body) => ({ body, write: false, creates: [] }),
    wroteWrite,
  } = {},
) {
  const calls = [];
  const github = await serve(t, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (hold) await hold;
      res.writeHead(200, { "content-type": "application/json", "x-github-request-id": "R1" });
      res.end(JSON.stringify({ url: req.url }));
    });
  });
  const broker = createBroker({ sentFrom });
  const minted = [];
  const fake = {
    repoToken: async (repo, extra) => (minted.push([repo, extra]), { token: TOKEN }),
  };
  const logged = [];
  let anonymous = null;
  const gw = createGithubGateway({
    broker,
    app: () => (app ? fake : null),
    api: `${github.url}/api/v3`,
    web: github.url,
    runFrom: async (ip) => (ip === "127.0.0.1" && anonymous ? broker.runOf(anonymous) : null),
    secrets: () => [OPERATOR],
    log: (line) => logged.push(line),
    maxInFlight,
    ...(checkWrite && { checkWrite }),
    ...(checkGraphql && { checkGraphql }),
    ...(wroteWrite && { wroteWrite }),
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  // A run, its log's notes beside it.
  const register = (extra, options) => {
    const secret = broker.register("Org/Repo", extra, options);
    const notes = [];
    broker.provide(secret, "anthropic", (line) => notes.push(line));
    return { secret, notes, run: broker.runOf(secret) };
  };
  // A call as the proxy relays it: /relay/<host><path>.
  const call = (path, { secret, auth, method = "GET", body, headers = {} } = {}) =>
    fetch(`${url}/relay/127.0.0.1${path}`, {
      method,
      body,
      headers: {
        ...headers,
        ...(auth ? { authorization: auth } : secret ? { authorization: `token ${secret}` } : {}),
      },
    });
  return {
    broker,
    calls,
    minted,
    logged,
    register,
    call,
    anonymousFrom: (secret) => (anonymous = secret),
    // A call fetch() won't send (a GET with a body): node:http's → { status, message } (none for
    // a HEAD).
    raw: (path, method, headers, body) =>
      new Promise((resolve, reject) => {
        const req = request(`${url}/relay/127.0.0.1${path}`, { method, headers }, (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () =>
            resolve({ status: res.statusCode, message: text && JSON.parse(text).message }),
          );
        });
        req.on("error", reject);
        req.end(body);
      }),
  };
}

test("a run's call goes on with a token for its repo, whichever way it sends its secret", async (t) => {
  const gw = await gateway(t);
  const { secret, run } = gw.register({ issues: "read" });
  const basic = Buffer.from(`x-access-token:${secret}`).toString("base64");
  for (const auth of [`token ${secret}`, `Bearer ${secret}`, `Basic ${basic}`]) {
    const res = await gw.call("/api/v3/repos/org/repo/issues?state=open", { auth });
    assert.equal(res.status, 200, auth);
    assert.deepEqual(await res.json(), { url: "/api/v3/repos/org/repo/issues?state=open" });
    assert.equal(res.headers.get("x-github-request-id"), "R1");
  }
  // The API with the token as a token, the web host (git) as Basic, as GitHub expects.
  assert.equal(gw.calls[0].headers.authorization, `token ${TOKEN}`);
  await gw.call("/org/repo.git/info/refs?service=git-upload-pack", { secret });
  const git = gw.calls.at(-1);
  assert.equal(git.url, "/org/repo.git/info/refs?service=git-upload-pack");
  assert.equal(
    git.headers.authorization,
    `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
  );
  // GraphQL, beside the REST API on GitHub Enterprise Server.
  const graphql = await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: JSON.stringify({ query: "{ viewer { login } }" }),
  });
  assert.equal(graphql.status, 200);
  assert.equal(gw.calls.at(-1).url, "/api/graphql");
  // Minted for its repo, with its mode's permissions, only read: none of these wrote; kept for
  // redaction (runs.mjs).
  assert.deepEqual(gw.minted[0], ["org/repo", readsOf({ issues: "read" })]);
  assert.deepEqual([...run.tokens], [TOKEN]);
  // Nothing of the sandbox's credential or address reaches GitHub.
  assert.ok(gw.calls.every((c) => !JSON.stringify(c.headers).includes(secret)));
});

test("a call without a secret is its sandbox's run's, found by its address", async (t) => {
  const gw = await gateway(t);
  const nobody = await gw.call("/api/v3/repos/org/repo");
  assert.equal(nobody.status, 401);
  assert.deepEqual(await nobody.json(), { message: "Deckhand: unknown or finished run" });
  const { secret } = gw.register();
  gw.anonymousFrom(secret);
  // git's first request, a download with curl: no credential, still the run's token.
  const res = await gw.call("/org/repo.git/info/refs?service=git-upload-pack");
  assert.equal(res.status, 200);
  assert.match(gw.calls[0].headers.authorization, /^Basic /);
});

test("another run's secret, a finished run's, another sandbox's or a research run's: nothing", async (t) => {
  const gw = await gateway(t, { sentFrom: sandboxAt("10.9.0.5") });
  const { secret } = gw.register();
  const answers = [];
  const ask = async (options) => {
    const res = await gw.call("/api/v3/repos/org/repo", options);
    answers.push(`${res.status} ${(await res.json()).message}`);
  };
  await ask({ secret: "guess" });
  await ask({ auth: "Basic" });
  await ask({ auth: "Negotiate x" });
  // The right secret, sent from the tests' address rather than its sandbox's.
  await ask({ secret });
  const research = gw.register(NO_TOKEN);
  const ok = await gateway(t);
  const r = ok.register(NO_TOKEN);
  const res = await ok.call("/api/v3/repos/org/repo", { secret: r.secret });
  answers.push(`${res.status} ${(await res.json()).message}`);
  ok.broker.revoke(r.secret);
  const after = await ok.call("/api/v3/repos/org/repo", { secret: r.secret });
  answers.push(`${after.status} ${(await after.json()).message}`);
  assert.deepEqual(answers, [
    "401 Deckhand: unknown or finished run",
    "401 Deckhand: unknown or finished run",
    "401 Deckhand: unknown or finished run",
    "403 Deckhand: this run's secret only works from its own sandbox",
    "403 Deckhand: this run gets nothing from GitHub",
    "401 Deckhand: unknown or finished run",
  ]);
  assert.ok(research.run);
  assert.deepEqual(gw.calls, []);
  assert.deepEqual(ok.calls, []);
  assert.deepEqual(gw.minted, []);
});

test("not GitHub's host or a path that leaves it: 404; before the App's setup: 503", async (t) => {
  const gw = await gateway(t, { app: false });
  const { secret } = gw.register();
  const other = await fetch(
    (await gw.call("/x", { secret })).url.replace("/relay/127.0.0.1/", "/relay/evil.example/"),
    { headers: { authorization: `token ${secret}` } },
  );
  assert.equal(other.status, 404);
  assert.equal((await gw.call("//evil.example/x", { secret })).status, 404);
  assert.equal((await gw.call("/api/v3/repos/org/repo", { secret })).status, 503);
  assert.deepEqual(gw.calls, []);
});

test("a push straight to GitHub is refused: pushes go through the git gateway", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register(undefined, { push: true });
  for (const [path, method] of [
    ["/org/repo.git/info/refs?service=git-receive-pack", "GET"],
    ["/org/repo.git/git-receive-pack", "POST"],
  ]) {
    const res = await gw.call(path, { secret, method, body: method === "POST" ? "x" : undefined });
    assert.equal(res.status, 403);
    assert.match((await res.json()).message, /git gateway/);
  }
  assert.deepEqual(gw.calls, []);
});

test("a write holding a secret reaches GitHub redacted, and the run's log says so", async (t) => {
  const gw = await gateway(t);
  const { secret, notes, run } = gw.register();
  run.tokens.add("an-earlier-token-0123456789");
  const shaped = `ghs_${"A".repeat(36)}`;
  const text = `Mine: ${secret}, the operator's: ${OPERATOR}, a token: ${shaped}, an old one: an-earlier-token-0123456789`;
  // An escaped character can't split one.
  const code = secret.charCodeAt(10).toString(16).padStart(4, "0");
  const escaped = `${secret.slice(0, 10)}\\u${code}${secret.slice(11)}`;
  const res = await gw.call("/api/v3/repos/org/repo/issues/1/comments", {
    secret,
    method: "POST",
    body: `{"body": ${JSON.stringify(text)}, "title": "${escaped}"}`,
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  const sent = JSON.parse(gw.calls[0].body.toString());
  assert.equal(
    sent.body,
    "Mine: [redacted], the operator's: [redacted], a token: [redacted], an old one: [redacted]",
  );
  assert.equal(sent.title, "[redacted]");
  assert.equal(gw.calls[0].headers["content-length"], String(gw.calls[0].body.length));
  assert.deepEqual(notes, [
    "Deckhand redacted a secret from the run's GitHub write POST /api/v3/repos/org/repo/issues/1/comments",
  ]);
  assert.match(gw.logged.join("\n"), /redacted a secret from POST .* for org\/repo/);
  // A clean write goes on as it was sent, byte for byte, unnoted.
  const clean = '{ "body": "Done." }';
  await gw.call("/api/v3/repos/org/repo/issues/1/comments", {
    secret,
    method: "PATCH",
    body: clean,
  });
  assert.equal(gw.calls[1].body.toString(), clean);
  assert.equal(notes.length, 1);
  // GraphQL's variables and inline literals alike, and a body that isn't JSON, as text.
  await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: JSON.stringify({
      query: `mutation { addComment(input: {subjectId: "I_1", body: "${OPERATOR}"}) { clientMutationId } }`,
      variables: { body: shaped },
    }),
  });
  const graphql = JSON.parse(gw.calls[2].body.toString());
  assert.match(graphql.query, /body: "\[redacted\]"/);
  assert.equal(graphql.variables.body, "[redacted]");
  await gw.call("/api/v3/markdown/raw", { secret, method: "POST", body: `text ${secret}` });
  assert.equal(gw.calls[3].body.toString(), "text [redacted]");
});

test("a write whose URL holds a secret is refused, and noted; a read's isn't", async (t) => {
  const gw = await gateway(t);
  const { secret, notes } = gw.register();
  const encoded = [...OPERATOR].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
  for (const path of [
    `/api/v3/repos/org/repo/issues/1/comments?body=${secret}`,
    `/api/v3/repos/org/repo/labels/${encoded}`,
  ]) {
    const res = await gw.call(path, { secret, method: "POST", body: "{}" });
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).message, /URL holds a secret/);
  }
  assert.deepEqual(gw.calls, []);
  assert.match(notes[0], /refused the run's GitHub write POST .*: its URL holds a secret/);
  assert.ok(!notes.join("").includes(secret));
  assert.ok(!notes.join("").includes(encoded) && !notes.join("").includes(OPERATOR));
  assert.equal((await gw.call(`/api/v3/search/issues?q=${secret}`, { secret })).status, 200);
});

test("a fetch's pack request streams through unread, binary as it is", async (t) => {
  const gw = await gateway(t);
  const { secret, notes } = gw.register();
  const pack = Buffer.from([0, 1, 2, 255, 254, 10]);
  const res = await gw.call("/org/repo.git/git-upload-pack", {
    secret,
    method: "POST",
    body: pack,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(gw.calls[0].body, pack);
  assert.deepEqual(notes, []);
});

test("a read with a body is refused: its body would go on unread", async (t) => {
  const gw = await gateway(t);
  const review = gw.register(undefined, { mode: "review" });
  const auth = { authorization: `token ${review.secret}` };
  const query =
    '{ repository(owner: "o", name: "r") { pullRequest(number: 1) { comments(last: 9) { nodes { body } } } } }';
  const body = JSON.stringify({ query, note: OPERATOR });
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const headers = { ...auth, "content-length": String(Buffer.byteLength(body)) };
    const res = await gw.raw("/api/graphql", method, headers, method === "HEAD" ? "" : body);
    assert.equal(res.status, 400, method);
  }
  const got = await gw.raw("/api/graphql", "GET", { ...auth, "content-length": "5" }, "hello");
  assert.match(got.message, /a GET with a body/);
  // Chunked, without a length: a body too.
  const chunked = await gw.raw(
    "/api/v3/repos/org/repo",
    "GET",
    { ...auth, "transfer-encoding": "chunked" },
    body,
  );
  assert.equal(chunked.status, 400);
  assert.deepEqual(gw.calls, []);
  // Without one: read as usual.
  assert.equal((await gw.call("/api/v3/repos/org/repo", { secret: review.secret })).status, 200);
});

test("a compressed write is refused, a review's GraphQL call too: neither could be read", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register();
  const review = gw.register(undefined, { mode: "review" });
  const cases = [
    [secret, "/api/v3/repos/org/repo/issues/1/comments", { body: `Mine: ${secret}` }],
    [
      review.secret,
      "/api/graphql",
      { query: "{ viewer { issueComments(last: 5) { nodes { body } } } }" },
    ],
  ];
  for (const [who, path, json] of cases) {
    for (const encoding of ["gzip", "deflate", " GZIP "]) {
      const res = await gw.call(path, {
        secret: who,
        method: "POST",
        body: gzipSync(JSON.stringify(json)),
        headers: { "content-encoding": encoding },
      });
      assert.equal(res.status, 415, `${path} ${encoding}`);
    }
  }
  assert.deepEqual(gw.calls, []);
  // Uncompressed, said so: read as usual.
  const plain = await gw.call("/api/v3/repos/org/repo/issues/1/comments", {
    secret,
    method: "POST",
    body: '{"body": "Done."}',
    headers: { "content-encoding": "identity" },
  });
  assert.equal(plain.status, 200);
});

test("a write too big to read is refused", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register();
  const big = "x".repeat(16 * 1024 * 1024 + 1);
  const res = await gw.call("/api/v3/repos/org/repo/issues", { secret, method: "POST", body: big });
  assert.equal(res.status, 413);
  assert.deepEqual(gw.calls, []);
});

test("a review can't read its thread's comments and reviews; other runs can", async (t) => {
  const gw = await gateway(t);
  const review = gw.register(undefined, { mode: "review" });
  const work = gw.register(undefined, { mode: "work", push: true });
  const refused = [
    ["/api/v3/repos/org/repo/issues/12/comments", "GET"],
    ["/api/v3/repos/org/repo/issues/comments/99", "GET"],
    ["/api/v3/repos/Org/Repo/issues/12/timeline?per_page=100", "GET"],
    ["/api/v3/repos/org/repo/pulls/12/comments", "GET"],
    ["/api/v3/repos/org/repo/pulls/12/reviews", "GET"],
    ["/api/v3/repos/org/repo/pulls/12/reviews/5/comments", "GET"],
    ["/api/v3/repos/org/repo/pulls/comments/7", "GET"],
    ["/api/v3/repos/org/repo/comments", "GET"],
    ["/api/v3/repos/org/repo/commits/abc/comments", "GET"],
    // Spelled another way.
    ["/api/v3/repos/org/repo/issues/12/%63omments", "GET"],
    ["/api/v3/repos/org//repo/issues/12/comments", "GET"],
    // By the repository's id, as GitHub's pagination links name it.
    ["/api/v3/repositories/42/issues/12/comments", "GET"],
    ["/api/v3/repositories/42/pulls/12/reviews", "GET"],
    ["/api/v3/repositories/42/issues/comments", "GET"],
    // The event feeds, whose comment and review events carry their bodies.
    ["/api/v3/repos/org/repo/events", "GET"],
    ["/api/v3/repositories/42/events", "GET"],
    ["/api/v3/networks/org/repo/events", "GET"],
    ["/api/v3/users/mallory/events/public", "GET"],
    ["/api/v3/users/mallory/received_events", "GET"],
    ["/api/v3/orgs/org/events", "GET"],
    ["/api/v3/events", "GET"],
    // Issue search, whose in:comments and text matches read comment text.
    ["/api/v3/search/issues?q=repo:org/repo+in:comments+deploy", "GET"],
    // The web host's pages show them too.
    ["/org/repo/pull/12", "GET"],
  ];
  for (const [path, method] of refused) {
    const res = await gw.call(path, { secret: review.secret, method });
    assert.equal(res.status, 403, path);
    assert.match((await res.json()).message, /TASK_DIGEST/);
  }
  const graphql = (secret, query) =>
    gw.call("/api/graphql", { secret, method: "POST", body: JSON.stringify({ query }) });
  for (const body of [
    JSON.stringify({
      query:
        '{ repository(owner: "org", name: "repo") { pullRequest(number: 12) { comments(first: 10) { nodes { body } } } } }',
    }),
    JSON.stringify({
      query:
        '{ repository(owner: "org", name: "repo") { pullRequest(number: 12) { latestReviews(first: 5) { nodes { body } } } } }',
    }),
    JSON.stringify({ query: '{ node(id: "IC_1") { ... on IssueComment { body } } }' }),
    // The interface every comment and review implements, and their edit history.
    JSON.stringify({ query: '{ node(id: "IC_1") { ... on Comment { body } } }' }),
    JSON.stringify({ query: '{ node(id: "UCE_1") { ... on UserContentEdit { diff } } }' }),
    // Escaped in its JSON.
    '{"query": "{ node(id: \\"x\\") { ... on Issue\\u0043omment { body } } }"}',
    // Search, whose text matches quote what they matched.
    JSON.stringify({
      query:
        '{ search(query: "repo:o/r in:comments x", type: ISSUE, first: 5) { edges { textMatches { fragment } } } }',
    }),
    // Connections named after them: a repository's commit comments, a commenter's comments.
    JSON.stringify({
      query:
        '{ repository(owner: "o", name: "r") { commitComments(last: 50) { nodes { body } } } }',
    }),
    JSON.stringify({
      query:
        '{ user(login: "mallory") { issueComments(last: 50) { nodes { body issue { number } } } } }',
    }),
  ]) {
    // At GraphQL's path, and spelled any other way: a review's every body is read.
    for (const path of [
      "/api/graphql",
      "/api/%67raphql",
      "/api/graphql/",
      "/api/GraphQL",
      "/api/v3/graphql",
      "/api/v3/%67raphql",
    ]) {
      const res = await gw.call(path, { secret: review.secret, method: "POST", body });
      assert.equal(res.status, 403, `${path} ${body}`);
    }
  }
  assert.deepEqual(gw.calls, []);
  assert.match(review.notes[0], /refused the review's call GET .*issues\/12\/comments/);
  // What a review does read: the pull request, its diff, its code.
  for (const path of [
    "/api/v3/repos/org/repo/pulls/12",
    "/api/v3/repos/org/repo/issues/12",
    // A repository named like a feed is no feed.
    "/api/v3/repos/org/events/pulls/12",
    "/org/repo.git/info/refs?service=git-upload-pack",
  ]) {
    assert.equal((await gw.call(path, { secret: review.secret })).status, 200, path);
  }
  assert.equal(
    (
      await graphql(
        review.secret,
        '{ repository(owner: "o", name: "r") { pullRequest(number: 1) { headRefName } } }',
      )
    ).status,
    200,
  );
  // Another run reads them.
  for (const [path] of refused) {
    assert.equal((await gw.call(path, { secret: work.secret })).status, 200, path);
  }
  assert.equal((await graphql(work.secret, "{ viewer { comments: login } }")).status, 200);
});

test("a REST write goes on only when its check passes; GraphQL and git don't go through the REST check", async (t) => {
  const checked = [];
  const gw = await gateway(t, {
    checkWrite: async (run, write) => {
      checked.push({ ...write, body: write.body.toString() });
      return write.path.endsWith("/comments")
        ? { status: 403, message: "the policies refuse it (deny_github): not here" }
        : null;
    },
  });
  const { secret, notes } = gw.register(undefined, { mode: "work", push: true, issue: 1 });
  const refused = await gw.call("/api/v3/repos/org/repo/issues/2/comments", {
    secret,
    method: "POST",
    body: '{"body": "Hi"}',
  });
  assert.equal(refused.status, 403);
  // GitHub's error shape: what gh prints.
  assert.deepEqual(await refused.json(), {
    message: "Deckhand: the policies refuse it (deny_github): not here",
  });
  assert.deepEqual(notes, [
    "Deckhand refused the run's GitHub write POST /api/v3/repos/org/repo/issues/2/comments: the policies refuse it (deny_github): not here",
  ]);
  assert.match(gw.logged.join("\n"), /refused POST .*issues\/2\/comments for org\/repo/);
  const ok = await gw.call("/api/v3/repos/org/repo/issues/1", {
    secret,
    method: "PATCH",
    body: '{"title": "T"}',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(
    gw.calls.map((c) => c.url),
    ["/api/v3/repos/org/repo/issues/1"],
  );
  // The path under the API's base, decoded; the body as GitHub gets it.
  assert.deepEqual(checked, [
    {
      method: "POST",
      path: "repos/org/repo/issues/2/comments",
      body: '{"body": "Hi"}',
    },
    { method: "PATCH", path: "repos/org/repo/issues/1", body: '{"title": "T"}' },
  ]);
  for (const path of ["/api/graphql", "/api/v3/graphql", "/api/GraphQL/"]) {
    await gw.call(path, { secret, method: "POST", body: '{"query": "{ viewer { login } }"}' });
  }
  await gw.call("/org/repo.git/git-upload-pack", { secret, method: "POST", body: "0000" });
  assert.equal(checked.length, 2);
  assert.equal(gw.calls.length, 5);
});

test("a REST write with a query string is refused unchecked: GitHub may read it", async (t) => {
  const checked = [];
  const gw = await gateway(t, { checkWrite: async (run, write) => (checked.push(write), null) });
  const { secret, notes } = gw.register(undefined, { mode: "work", push: true, issue: 1 });
  for (const path of [
    "/api/v3/repos/org/repo/issues/1/sub_issues?replace_parent=true",
    "/api/v3/repos/org/repo/issues/1?state=closed",
  ]) {
    const res = await gw.call(path, {
      secret,
      method: path.includes("sub_issues") ? "POST" : "PATCH",
      body: '{"sub_issue_id": 2, "title": "T"}',
    });
    assert.equal(res.status, 400, path);
    assert.match((await res.json()).message, /a write with a query string/);
  }
  assert.deepEqual(checked, []);
  assert.deepEqual(gw.calls, []);
  assert.match(notes[1], /refused the run's GitHub write PATCH .*: a write with a query string/);
  // GraphQL's too, whatever it holds; reads' are theirs.
  const graphql = await gw.call("/api/graphql?x=1", {
    secret,
    method: "POST",
    body: '{"query": "{ a }"}',
  });
  assert.equal(graphql.status, 400);
  await gw.call("/api/v3/repos/org/repo/issues?state=open", { secret });
  assert.equal(gw.calls.length, 1);
});

test("the answers of REST writes and GraphQL createIssue calls go to wroteWrite, uncompressed", async (t) => {
  const wrote = [];
  const gw = await gateway(t, {
    wroteWrite: (run, write, status, answer) =>
      wrote.push([
        run,
        write.method,
        write.path,
        write.graphql,
        write.creates,
        status,
        answer.toString(),
      ]),
    // github-graphql.mjs: the response keys of a call's createIssue fields.
    checkGraphql: async (run, body) => ({
      body,
      write: true,
      creates: body.includes("createIssue") ? ["createIssue", "b"] : [],
    }),
  });
  const { secret, run } = gw.register(undefined, { mode: "work", push: true, issue: 1 });
  const gzip = { "accept-encoding": "gzip" };
  await gw.call("/api/v3/repos/org/repo/issues", {
    secret,
    method: "POST",
    body: '{"title": "T"}',
    headers: gzip,
  });
  const mutation = "mutation { createIssue(input: {}) { issue { url } } }";
  await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: JSON.stringify({ query: mutation }),
    headers: gzip,
  });
  // Neither a read nor another GraphQL call: their answers aren't read, nor their encoding set.
  await gw.call("/api/v3/repos/org/repo", { secret, headers: gzip });
  await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: '{"query": "mutation { addComment(input: {}) { clientMutationId } }"}',
    headers: gzip,
  });
  assert.deepEqual(
    gw.calls.map((c) => c.headers["accept-encoding"]),
    ["identity", "identity", "gzip", "gzip"],
  );
  assert.deepEqual(
    wrote.map(([r, ...rest]) => [r === run, ...rest]),
    [
      [
        true,
        "POST",
        "repos/org/repo/issues",
        false,
        undefined,
        200,
        '{"url":"/api/v3/repos/org/repo/issues"}',
      ],
      [true, "POST", "api/graphql", true, ["createIssue", "b"], 200, '{"url":"/api/graphql"}'],
    ],
  );
});

test("GraphQL goes on as its check printed it, with a token that writes only for a checked write", async (t) => {
  const checked = [];
  const gw = await gateway(t, {
    checkGraphql: async (run, body) => {
      checked.push(body.toString());
      if (body.includes("deleteIssue")) {
        return { refused: { status: 403, message: "Deckhand doesn't let a run send deleteIssue" } };
      }
      const write = body.includes("mutation");
      return { body: Buffer.from(`{"query":"printed ${write}"}`), write, creates: [] };
    },
  });
  const extra = { issues: "write" };
  const { secret, notes } = gw.register(extra, { mode: "brainstorm", issue: 1 });
  const post = (query, path = "/api/graphql") =>
    gw.call(path, { secret, method: "POST", body: JSON.stringify({ query }) });
  assert.equal((await post("{ viewer { login } }")).status, 200);
  assert.equal((await post("mutation { addComment }")).status, 200);
  const refused = await post("mutation { deleteIssue }");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    message: "Deckhand: Deckhand doesn't let a run send deleteIssue",
  });
  assert.match(notes.at(-1), /refused the run's GitHub write POST \/api\/graphql: .*deleteIssue/);
  // What GitHub got: the check's document, never the call's own bytes.
  assert.deepEqual(
    gw.calls.map((c) => c.body.toString()),
    ['{"query":"printed false"}', '{"query":"printed true"}'],
  );
  // The read with a token that only reads, the checked mutation with its mode's.
  assert.deepEqual(
    gw.minted.map(([, perms]) => perms),
    [readsOf(extra), extra],
  );
  assert.equal(readsOf(extra).issues, "read");
  // GraphQL is a POST: a GET's query would go on unchecked.
  const get = await gw.call("/api/graphql?query=mutation%7BdeleteIssue%7D", { secret });
  assert.equal(get.status, 405);
  assert.equal(checked.length, 3);
  assert.equal(gw.calls.length, 2);
});

test("without a GraphQL check, every GraphQL call is refused", async (t) => {
  const gw = await gateway(t, { checkGraphql: null });
  const { secret } = gw.register(undefined, { mode: "work", push: true });
  const res = await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: '{"query": "{ viewer { login } }"}',
  });
  assert.equal(res.status, 403);
  assert.deepEqual(gw.calls, []);
});

test("without a write check, every REST write is refused", async (t) => {
  const gw = await gateway(t, { checkWrite: null });
  const { secret } = gw.register(undefined, { mode: "work", push: true });
  const res = await gw.call("/api/v3/repos/org/repo/issues", {
    secret,
    method: "POST",
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.deepEqual(gw.calls, []);
});

test("a run has so many calls in flight at once", async (t) => {
  let release;
  const gw = await gateway(t, { maxInFlight: 1, hold: new Promise((r) => (release = r)) });
  const { secret } = gw.register();
  const first = gw.call("/api/v3/repos/org/repo", { secret });
  while (!gw.calls.length) await new Promise((r) => setTimeout(r, 5));
  const second = await gw.call("/api/v3/repos/org/repo", { secret });
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await gw.call("/api/v3/repos/org/repo", { secret })).status, 200);
});

test("secretOf, redactBody and readsThread", () => {
  assert.equal(secretOf(undefined), undefined);
  assert.equal(secretOf("token abc"), "abc");
  assert.equal(secretOf("Bearer abc"), "abc");
  assert.equal(secretOf(`Basic ${Buffer.from("x:y:z").toString("base64")}`), "y:z");
  assert.equal(secretOf("Negotiate abc"), "");
  const secret = "s3cret-0123456789abcdef";
  assert.equal(redactBody(Buffer.from('{"a": 1}'), [secret]), null);
  assert.equal(
    String(redactBody(Buffer.from(`{"a": ["${secret}"]}`), [secret])),
    '{"a": ["[redacted]"]}',
  );
  // The rest of the body as it was sent: a number past 2^53, its spacing, other strings.
  const big = `{"n": 12345678901234567890, "x": 1.50, "s": "\\u00e9", "b": "${secret}"}`;
  assert.equal(
    String(redactBody(Buffer.from(big), [secret])),
    '{"n": 12345678901234567890, "x": 1.50, "s": "\\u00e9", "b": "[redacted]"}',
  );
  // Not UTF-8: redacted as bytes, the others kept.
  const binary = Buffer.concat([
    Buffer.from([0xff, 0x00]),
    Buffer.from(secret),
    Buffer.from([0xfe]),
  ]);
  assert.deepEqual(
    redactBody(binary, [secret]),
    Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("[redacted]"), Buffer.from([0xfe])]),
  );
  assert.equal(String(redactBody(Buffer.from(`a=${secret}`), [secret])), "a=[redacted]");
  assert.equal(readsThread('{"query": "{ viewer { login } }"}'), false);
  assert.equal(readsThread('{"query": "{ a { reviewThreads { b } } }"}'), true);
});

test("a secret spelled with GraphQL's own escapes is redacted from the document as printed", async (t) => {
  const checks = createGraphqlChecks({ nodes: async () => [], checkWrite: async () => null });
  const gw = await gateway(t, { checkGraphql: checks.check });
  const { secret, notes } = gw.register(undefined, { mode: "work", push: true, issue: 1 });
  // Every third character as \u00XX: the call's JSON holds no secret, its GraphQL does.
  const escaped = [...OPERATOR]
    .map((c, i) => (i % 3 ? c : `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`))
    .join("");
  const query = `{ repository(owner: "${escaped}", name: "repo") { id } }`;
  const res = await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: JSON.stringify({ query }),
  });
  assert.equal(res.status, 200);
  const sent = gw.calls.at(-1).body.toString();
  assert.ok(!sent.includes(OPERATOR));
  assert.match(JSON.parse(sent).query, /owner: "\[redacted\]"/);
  assert.match(
    notes.join("\n"),
    /redacted a secret from the run's GitHub write POST \/api\/graphql/,
  );
});

test("a POST that writes nothing (rendering markdown) goes on with a token that only reads", async (t) => {
  const gw = await gateway(t);
  const extra = { issues: "write" };
  const { secret } = gw.register(extra, { mode: "work", push: true, issue: 1 });
  const post = (path) => gw.call(path, { secret, method: "POST", body: '{"text": "**Hi**"}' });
  assert.equal((await post("/api/v3/markdown")).status, 200);
  assert.equal((await post("/api/v3/repos/org/repo/issues/1/comments")).status, 200);
  assert.deepEqual(
    gw.minted.map(([, perms]) => perms),
    [readsOf(extra), extra],
  );
});
