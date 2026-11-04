// The GitHub gateway (github-gateway.mjs): a sandbox's GitHub calls, relayed by the egress proxy,
// go on with a token for its run's repo, their writes redacted; nobody else's do.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readsOf } from "../listener/github-app.mjs";
import { createGraphqlChecks } from "../listener/github-graphql.mjs";
import {
  createGithubGateway,
  explained,
  logStorage,
  needed,
  packIn,
  readsChecks,
  readsThread,
  redactBody,
  secretOf,
} from "../listener/github-gateway.mjs";
import { createReadChecks } from "../listener/github-writes.mjs";
import { defaultPolicies, hasOpa, serve, tokenBroker } from "./helpers.mjs";

const TOKEN = "repo-token-0123456789abcdef";
const OPERATOR = "operator-key-0123456789abcdef";
// The reads of a work run before capabilities: the code, issues, pull requests and CI.
const WORK_READS = ["pull", "read:issues", "read:pulls", "read:actions"];
// What their token gets.
const READS = readsOf(WORK_READS);

// A fake GitHub, on GitHub Enterprise Server's layout (its API under /api/v3, on the web's
// host), and a gateway in front of it. `anonymous`: the run a call without a token is from.
// `address`: where its runs' sandbox is (127.0.0.1, the tests', by default).
// `checkWrite`: what the REST writes are held to (github-writes.mjs): here, nothing; null, the
// gateway's own default. `checkGraphql`: the same for GraphQL (github-graphql.mjs): here, its
// body goes on as a read.
async function gateway(
  t,
  {
    address = "127.0.0.1",
    app = true,
    maxInFlight,
    hold,
    checkWrite = async () => null,
    checkGraphql = async (run, body) => ({ body, write: false, creates: [] }),
    wroteWrite,
    respond,
    lacking,
    forks,
    readsProjects,
    checkRead,
    repoId,
    observe,
    onGit,
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
      if (respond?.(req, res)) return;
      res.writeHead(200, { "content-type": "application/json", "x-github-request-id": "R1" });
      res.end(JSON.stringify({ url: req.url }));
    });
  });
  const broker = tokenBroker({ address });
  const minted = [];
  const fake = {
    repoToken: async (repo, extra) => (minted.push([repo, extra]), { token: TOKEN }),
    ...(lacking && { lacking }),
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
    ...(forks && { forks }),
    ...(readsProjects && { readsProjects }),
    ...(checkRead && { checkRead }),
    ...(repoId && { repoId }),
    ...(observe && { observe }),
    ...(onGit && { onGit }),
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  // A run, its log's notes beside it: by default with the reads a work run's token had
  // before capabilities. `secret`: its run token.
  const register = (options = {}) => {
    const id = broker.register("Org/Repo", { caps: WORK_READS, ...options });
    const notes = [];
    broker.provide(id, "anthropic", (line) => notes.push(line));
    return { secret: broker.token(id), notes, run: broker.runOf(id) };
  };
  // A call as the proxy relays it: /relay/<host><path>.
  const call = (
    path,
    { secret, auth, method = "GET", body, headers = {}, redirect, signal } = {},
  ) =>
    fetch(`${url}/relay/127.0.0.1${path}`, {
      method,
      body,
      signal,
      ...(redirect && { redirect }),
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
  const { secret, run } = gw.register();
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
  // Minted for its repo, with what its capabilities read: none of these wrote; kept for
  // redaction (runs.mjs).
  assert.deepEqual(gw.minted[0], ["org/repo", READS]);
  assert.deepEqual(READS, {
    metadata: "read",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    actions: "read",
    checks: "read",
    statuses: "read",
  });
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
  const gw = await gateway(t, { address: "10.9.0.5" });
  const { secret } = gw.register();
  const answers = [];
  const ask = async (options) => {
    const res = await gw.call("/api/v3/repos/org/repo", options);
    answers.push(`${res.status} ${(await res.json()).message}`);
  };
  await ask({ secret: "guess" });
  await ask({ auth: "Basic" });
  await ask({ auth: "Negotiate x" });
  // The right token, sent from the tests' address rather than its sandbox's.
  await ask({ secret });
  const research = gw.register({ caps: ["internet"] });
  const ok = await gateway(t);
  const r = ok.register({ caps: ["internet"] });
  const res = await ok.call("/api/v3/repos/org/repo", { secret: r.secret });
  answers.push(`${res.status} ${(await res.json()).message}`);
  ok.broker.revoke(r.secret);
  const after = await ok.call("/api/v3/repos/org/repo", { secret: r.secret });
  answers.push(`${after.status} ${(await after.json()).message}`);
  assert.deepEqual(answers, [
    "401 Deckhand: unknown or finished run",
    "401 Deckhand: unknown or finished run",
    "401 Deckhand: unknown or finished run",
    "403 Deckhand: this run's token only works from its own sandbox",
    "403 Deckhand: this run gets nothing from GitHub: it doesn't have `pull`",
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
  const { secret } = gw.register({ push: true });
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
  const review = gw.register({ mode: "review" });
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
  const review = gw.register({ mode: "review" });
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
  const review = gw.register({ mode: "review" });
  const work = gw.register({ mode: "work", push: true });
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
        ? { status: 403, message: "the policies refuse it: not here" }
        : null;
    },
  });
  const { secret, notes } = gw.register({ mode: "work", push: true, issue: 1 });
  const refused = await gw.call("/api/v3/repos/org/repo/issues/2/comments", {
    secret,
    method: "POST",
    body: '{"body": "Hi"}',
  });
  assert.equal(refused.status, 403);
  // GitHub's error shape: what gh prints.
  assert.deepEqual(await refused.json(), {
    message: "Deckhand: the policies refuse it: not here",
  });
  assert.deepEqual(notes, [
    "Deckhand refused the run's GitHub write POST /api/v3/repos/org/repo/issues/2/comments: the policies refuse it: not here",
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
  const { secret, notes } = gw.register({ mode: "work", push: true, issue: 1 });
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

test("the answers of REST writes and GraphQL createIssue, addComment and addReaction calls go to wroteWrite, uncompressed", async (t) => {
  const wrote = [];
  const gw = await gateway(t, {
    wroteWrite: (run, write, status, answer) =>
      wrote.push([
        run,
        write.method,
        write.path,
        write.graphql,
        write.creates,
        write.comments,
        write.reacts,
        status,
        answer.toString(),
      ]),
    // github-graphql.mjs: the response keys of a call's createIssue and addComment fields, and
    // its new reactions.
    checkGraphql: async (run, body) => ({
      body,
      write: true,
      creates: body.includes("createIssue") ? ["createIssue", "b"] : [],
      comments: body.includes("commentEdge") ? ["addComment"] : [],
      reacts: body.includes("addReaction")
        ? [{ key: "addReaction", subject: "issue:1", content: "+1" }]
        : [],
    }),
  });
  const { secret, run } = gw.register({ mode: "work", push: true, issue: 1 });
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
  await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: '{"query": "mutation { addComment(input: {}) { commentEdge { node { url } } } }"}',
    headers: gzip,
  });
  await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: '{"query": "mutation { addReaction(input: {}) { clientMutationId } }"}',
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
    ["identity", "identity", "identity", "identity", "gzip", "gzip"],
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
        undefined,
        undefined,
        200,
        '{"url":"/api/v3/repos/org/repo/issues"}',
      ],
      [
        true,
        "POST",
        "api/graphql",
        true,
        ["createIssue", "b"],
        [],
        [],
        200,
        '{"url":"/api/graphql"}',
      ],
      [true, "POST", "api/graphql", true, [], ["addComment"], [], 200, '{"url":"/api/graphql"}'],
      [
        true,
        "POST",
        "api/graphql",
        true,
        [],
        [],
        [{ key: "addReaction", subject: "issue:1", content: "+1" }],
        200,
        '{"url":"/api/graphql"}',
      ],
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
      // An addComment's: github-graphql.mjs permissionsOf().
      const permissions = write ? { issues: "write" } : {};
      return { body: Buffer.from(`{"query":"printed ${write}"}`), write, creates: [], permissions };
    },
  });
  const { secret, notes } = gw.register({ mode: "brainstorm", issue: 1 });
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
  // The read with a token that only reads, the checked mutation with its reads and its own
  // write.
  assert.deepEqual(
    gw.minted.map(([, perms]) => perms),
    [READS, { ...READS, issues: "write" }],
  );
  // GraphQL is a POST: a GET's query would go on unchecked.
  const get = await gw.call("/api/graphql?query=mutation%7BdeleteIssue%7D", { secret });
  assert.equal(get.status, 405);
  assert.equal(checked.length, 3);
  assert.equal(gw.calls.length, 2);
});

test("without a GraphQL check, every GraphQL call is refused", async (t) => {
  const gw = await gateway(t, { checkGraphql: null });
  const { secret } = gw.register({ mode: "work", push: true });
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
  const { secret } = gw.register({ mode: "work", push: true });
  const res = await gw.call("/api/v3/repos/org/repo/issues", {
    secret,
    method: "POST",
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.deepEqual(gw.calls, []);
});

test("without a read check, every read of CI's checks is refused; other reads go on", async (t) => {
  const gw = await gateway(t);
  const { secret } = gw.register({ mode: "work", push: true });
  const res = await gw.call("/api/v3/repos/org/repo/commits/abc/status", { secret });
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /no read of CI's checks is checked here/);
  assert.equal((await gw.call("/api/v3/repos/org/repo/commits/abc", { secret })).status, 200);
  assert.equal(gw.calls.length, 1);
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
  const { secret, notes } = gw.register({ mode: "work", push: true, issue: 1 });
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
  const { secret } = gw.register({ mode: "work", push: true, issue: 1 });
  const post = (path) => gw.call(path, { secret, method: "POST", body: '{"text": "**Hi**"}' });
  assert.equal((await post("/api/v3/markdown")).status, 200);
  assert.equal((await post("/api/v3/repos/org/repo/issues/1/comments")).status, 200);
  assert.deepEqual(
    gw.minted.map(([, perms]) => perms),
    [READS, { ...READS, issues: "write" }],
  );
});

test("a pull request's own write goes on with the token it needs, its answer to wroteWrite", async (t) => {
  const wrote = [];
  const gw = await gateway(t, {
    wroteWrite: (run, write, status) => wrote.push([write.graphql, write.pulls, status]),
    // github-graphql.mjs: gh pr ready's mutation, and a query.
    checkGraphql: async (run, body) =>
      body.includes("mutation")
        ? {
            body,
            write: true,
            creates: [],
            permissions: { contents: "write" },
            pulls: [{ key: "m", number: 7, head: null, ready: true }],
          }
        : { body, write: false, creates: [], permissions: {}, pulls: [] },
  });
  const { secret } = gw.register({ mode: "work", push: true, issue: 1 });
  const post = (path, body) => gw.call(path, { secret, method: "POST", body });
  assert.equal((await post("/api/graphql", '{"query": "mutation { m }"}')).status, 200);
  assert.equal((await post("/api/graphql", '{"query": "{ viewer { login } }"}')).status, 200);
  const create = '{"title": "T", "head": "issue-1-x", "base": "main"}';
  assert.equal((await post("/api/v3/repos/org/repo/pulls", create)).status, 200);
  // gh pr update-branch over REST: contents: write for that call, not the next.
  const update = '{"expected_head_sha": "0123456789abcdef0123456789abcdef01234567"}';
  const path = "/api/v3/repos/org/repo/pulls/7/update-branch";
  assert.equal((await gw.call(path, { secret, method: "PUT", body: update })).status, 200);
  assert.equal((await post("/api/v3/repos/org/repo/issues/1/comments", "{}")).status, 200);
  // A reply in a review thread: the same token, and nothing for the dashboard.
  const reply = "/api/v3/repos/org/repo/pulls/7/comments/40/replies";
  assert.equal((await post(reply, '{"body": "Fixed."}')).status, 200);
  // Each its reads and its own write only (github-writes.mjs writePermissions()).
  assert.deepEqual(
    gw.minted.map(([, perms]) => perms),
    [
      { ...READS, contents: "write" },
      READS,
      { ...READS, pull_requests: "write" },
      { ...READS, contents: "write" },
      { ...READS, issues: "write" },
      { ...READS, pull_requests: "write" },
    ],
  );
  assert.deepEqual(wrote, [
    [true, [{ key: "m", number: 7, head: null, ready: true }], 200],
    [false, [{ key: null, number: null, head: "issue-1-x", ready: true }], 200],
    [false, [{ key: null, number: 7, head: null, ready: false }], 200],
    [false, [], 200],
    [false, [], 200],
  ]);
});

test("a repo granted a project: its runs' tokens read projects, and a project write writes them", async (t) => {
  let granted = true;
  // The policies' `read_projects` (github-writes.mjs createReadChecks()): allowed here.
  const reads = [];
  const gw = await gateway(t, {
    checkRead: async (run, action) => (reads.push([run.mode, action]), null),
    readsProjects: (repo) => {
      assert.equal(repo, "org/repo");
      if (granted === null) throw new Error("broken grants");
      return granted;
    },
    checkGraphql: async (run, body) =>
      body.includes("mutation")
        ? {
            body,
            write: true,
            creates: [],
            permissions: { organization_projects: "write" },
            pulls: [],
          }
        : { body, write: false, creates: [], permissions: {}, pulls: [] },
  });
  const { secret } = gw.register({ mode: "work", push: true, issue: 1 });
  const post = (body) => gw.call("/api/graphql", { secret, method: "POST", body });
  assert.equal((await post('{"query": "{ viewer { login } }"}')).status, 200);
  assert.equal((await post('{"query": "mutation { m }"}')).status, 200);
  // Not granted, or grants that can't be read: no project in its reads.
  granted = false;
  assert.equal((await post('{"query": "{ viewer { login } }"}')).status, 200);
  granted = null;
  assert.equal((await post('{"query": "{ viewer { login } }"}')).status, 200);
  assert.deepEqual(
    gw.minted.map(([, perms]) => perms),
    [
      { ...READS, organization_projects: "read" },
      { ...READS, organization_projects: "write" },
      READS,
      READS,
    ],
  );
  assert.match(gw.logged.at(-1), /org\/repo: its grants: broken grants/);
  // Asked only where a project is granted.
  assert.deepEqual(reads, [
    ["work", "read_projects"],
    ["work", "read_projects"],
  ]);
});

test(
  "Deckhand's policies: a work run's and a brainstorm's tokens read a granted project, not a review's, an inbox entry's or a discussion's",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    // Not the others, which read outsiders' text: nothing narrows the read to the granted
    // projects.
    const { checkRead } = createReadChecks({ policies: defaultPolicies(t) });
    const gw = await gateway(t, { readsProjects: () => true, checkRead });
    for (const [mode, reads] of [
      ["work", true],
      ["review", false],
      ["idea", false],
      ["discussion", false],
      ["analyze", false],
      ["brainstorm", true],
    ]) {
      const light = gw.register({ mode, issue: 1, push: mode === "work" });
      await gw.call("/api/graphql", {
        secret: light.secret,
        method: "POST",
        body: '{"query": "{ viewer { login } }"}',
      });
      assert.equal(gw.minted.at(-1)[1].organization_projects, reads ? "read" : undefined, mode);
    }
  },
);

test("an Actions log's redirect is followed by the gateway, without credentials; others go back", async (t) => {
  const stored = [];
  const storage = await serve(t, (req, res) => {
    stored.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Error: 2 tests failed\n");
  });
  const gw = await gateway(t, {
    respond: (req, res) => {
      if (!/\/logs$|\/elsewhere$/.test(req.url.split("?")[0])) return false;
      // Job 1's storage isn't plain HTTP(S), job 2's URL holds credentials: neither followed.
      // Job 3's goes to a host that isn't GitHub's log storage.
      const location = req.url.includes("/jobs/1/")
        ? "ftp://storage.example/job-logs.txt"
        : req.url.includes("/jobs/2/")
          ? `${storage.url.replace("//", "//user:pass@")}/job-logs.txt`
          : req.url.includes("/jobs/3/")
            ? "https://storage.example/job-logs.txt"
            : `${storage.url}/actions-results/job-logs.txt?sig=signed`;
      res.writeHead(302, { location });
      res.end();
      return true;
    },
  });
  const { secret } = gw.register({ actions: "read" });
  for (const path of [
    "/api/v3/repos/org/repo/actions/jobs/124/logs",
    "/api/v3/repos/org/repo/actions/runs/41/logs",
    "/api/v3/repos/org/repo/actions/runs/41/attempts/2/logs",
  ]) {
    // "manual": the sandbox's client follows nothing here, the gateway does.
    const res = await gw.call(path, { secret, headers: { cookie: "c=1" }, redirect: "manual" });
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "Error: 2 tests failed\n");
  }
  assert.equal(stored.length, 3);
  assert.equal(stored[0].url, "/actions-results/job-logs.txt?sig=signed");
  // Neither the App's token nor the run's secret, nor the sandbox's cookie, goes to the storage.
  for (const { headers } of stored) {
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.ok(!JSON.stringify(headers).includes(secret));
  }
  // GitHub itself got the token, as for any read.
  assert.equal(gw.calls[0].headers.authorization, `token ${TOKEN}`);
  // Any other path's redirect goes back to the sandbox as it came.
  const other = await gw.call("/api/v3/repos/org/repo/elsewhere", { secret, redirect: "manual" });
  assert.equal(other.status, 302);
  assert.equal(stored.length, 3);
  // A redirect it refuses to follow goes back as it came too.
  for (const [job, location] of [
    [1, "ftp://storage.example/job-logs.txt"],
    [2, `${storage.url.replace("//", "//user:pass@")}/job-logs.txt`],
    [3, "https://storage.example/job-logs.txt"],
  ]) {
    const res = await gw.call(`/api/v3/repos/org/repo/actions/jobs/${job}/logs`, {
      secret,
      redirect: "manual",
    });
    assert.deepEqual([res.status, res.headers.get("location")], [302, location]);
  }
  assert.equal(stored.length, 3);
});

test("a call needing an optional permission the installation lacks is refused, naming it", async (t) => {
  const asked = [];
  const gw = await gateway(t, {
    lacking: async (repo, wanted) => {
      asked.push([repo, wanted]);
      return wanted.actions
        ? { missing: ["actions: read"], account: "org", url: "https://github.com/inst/7" }
        : null;
    },
  });
  const { secret, notes } = gw.register({ actions: "read" });
  const res = await gw.call("/api/v3/repos/Org/Repo/actions/runs?branch=x", { secret });
  assert.equal(res.status, 403);
  const { message } = await res.json();
  assert.match(message, /^Deckhand: this needs the GitHub App's actions: read permission/);
  assert.match(
    message,
    /installation on org lacks: .* accepts it on https:\/\/github\.com\/inst\/7/,
  );
  assert.match(notes.at(-1), /refused the run's GitHub call .*actions: read/);
  assert.equal(gw.calls.length, 0);
  assert.deepEqual(asked, [["org/repo", { actions: "read" }]]);
  // Anything else goes on, asking for none.
  assert.equal((await gw.call("/api/v3/repos/org/repo/issues", { secret })).status, 200);
  assert.deepEqual(asked.at(-1), ["org/repo", {}]);
  assert.equal(gw.calls.length, 1);
});

test("a checked rerun gets actions: write for that call only, refused without it, naming it", async (t) => {
  let accepted = false;
  const wrote = [];
  // The rerun's slot (github-writes.mjs reserve()): freed once each call is over.
  let released = 0;
  const gw = await gateway(t, {
    // The checks resolve the rerun's run, which comes back with GitHub's answer.
    checkWrite: async (run, call) => {
      call.rerun = { run_id: 100, sha: "aaa", release: () => released++ };
      return null;
    },
    wroteWrite: (run, call, status) => wrote.push([call.rerun, status]),
    lacking: async (repo, wanted) =>
      wanted.actions === "write" && !accepted
        ? { missing: ["actions: write"], account: "org", url: "https://github.com/inst/7" }
        : null,
  });
  const { secret, notes } = gw.register({});
  const rerun = () =>
    gw.call("/api/v3/repos/org/repo/actions/runs/100/rerun-failed-jobs", {
      secret,
      method: "POST",
      body: "{}",
    });
  const refused = await rerun();
  assert.equal(refused.status, 403);
  assert.match(
    (await refused.json()).message,
    /^Deckhand: this needs the GitHub App's actions: write permission, which its installation on org lacks/,
  );
  assert.match(notes.at(-1), /refused the run's GitHub write .*actions: write/);
  assert.equal(gw.calls.length, 0);
  // Accepted: the rerun's token writes Actions, the next call's only reads them again.
  accepted = true;
  assert.deepEqual(wrote, []);
  // Refused before it went out: its slot freed all the same.
  assert.equal(released, 1);
  assert.equal((await rerun()).status, 200);
  assert.deepEqual(gw.minted.at(-1), ["org/repo", { ...READS, actions: "write" }]);
  assert.deepEqual(
    wrote.map(([rerun, status]) => [rerun.run_id, rerun.sha, status]),
    [[100, "aaa", 200]],
  );
  assert.equal(released, 2);
  await gw.call("/api/v3/repos/org/repo/actions/runs/100", { secret });
  assert.equal(gw.minted.at(-1)[1].actions, "read");
});

test("a work run's Actions log, its installation without `actions`: refused naming it, before the fork check", async (t) => {
  const checked = [];
  const gw = await gateway(t, {
    lacking: async (repo, wanted) =>
      wanted.actions ? { missing: ["actions: read"], account: "org", url: null } : null,
    // The fork check reads GitHub with the same permission: it would answer a 502.
    forks: {
      restricted: (run) => run.push,
      checkCall: async (run, call) => {
        checked.push(call.path);
        return { status: 502, message: "couldn't check whether it is a fork's; try again" };
      },
    },
  });
  const { secret, notes } = gw.register({ mode: "work", push: true, issue: 1 });
  const res = await gw.call("/api/v3/repos/org/repo/actions/runs/1/logs", { secret });
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /actions: read permission/);
  assert.match(notes.at(-1), /actions: read/);
  assert.deepEqual(checked, []);
  assert.equal(gw.calls.length, 0);
});

test("a project write from an installation without organization_projects: refused naming it", async (t) => {
  // The real GraphQL checks: GitHub answers null for every project the installation can't
  // see, which a missing permission makes all of them.
  const nodes = async (repo, ids) =>
    ids.map((id) =>
      id === "I_1"
        ? { __typename: "Issue", number: 1, repository: { nameWithOwner: "Org/Repo" } }
        : null,
    );
  const graphql = createGraphqlChecks({
    nodes,
    checkWrite: async () => ({ status: 500, message: "not reached" }),
  });
  let lacks = true;
  const gw = await gateway(t, {
    checkGraphql: graphql.check,
    lacking: async (repo, wanted) =>
      lacks && wanted.organization_projects
        ? {
            missing: ["organization_projects: write"],
            account: "org",
            url: "https://github.com/inst/7",
          }
        : null,
  });
  const { secret } = gw.register({ mode: "work", push: true, issue: 1 });
  const add = () =>
    gw.call("/api/graphql", {
      secret,
      method: "POST",
      body: JSON.stringify({
        query:
          'mutation { addProjectV2ItemById(input: {contentId: "I_1", projectId: "PV_3"}) { item { id } } }',
      }),
    });
  const res = await add();
  assert.equal(res.status, 403);
  assert.match(
    (await res.json()).message,
    /^Deckhand: this needs the GitHub App's organization_projects: write permission, which its installation on org lacks/,
  );
  // Granted: a project still not there is said as such.
  lacks = false;
  assert.match(
    (await (await add()).json()).message,
    /projectId isn't a project, or the GitHub App can't see it/,
  );
  assert.equal(gw.calls.length, 0);
});

test("needed: its own repository's path's optional permission, read, and a write's own", () => {
  const repo = "Org/Repo";
  assert.deepEqual(needed("repos/org/repo/actions/runs/1/logs", {}, repo), { actions: "read" });
  assert.deepEqual(needed("repos/ORG/repo/ACTIONS", {}, repo), { actions: "read" });
  // Another repository's (a public one's CI), or one by id: GitHub's to answer.
  assert.deepEqual(needed("repos/cli/cli/actions/runs", {}, repo), {});
  assert.deepEqual(needed("repositories/12/actions", {}, repo), {});
  assert.deepEqual(needed("repos/org/repo/actions/runs/1/rerun", { actions: "write" }, repo), {
    actions: "write",
  });
  assert.deepEqual(needed("repos/org/repo/issues", { issues: "write" }, repo), {
    issues: "write",
  });
  assert.deepEqual(needed("repos/org/repo/actionsx", {}, repo), {});
});

test("a checked write needing an optional permission the installation lacks: refused, REST or GraphQL", async (t) => {
  // `pull_requests` stands for an optional permission here: no route carries one yet.
  const lacking = async (repo, wanted) => {
    const missing = Object.entries(wanted)
      .filter(([name, level]) => ["pull_requests", "actions"].includes(name) && level === "write")
      .map(([name, level]) => `${name}: ${level}`);
    return missing.length ? { missing, account: "org", url: null } : null;
  };
  let graphql = { write: true, permissions: { actions: "write" } };
  const gw = await gateway(t, {
    lacking,
    checkGraphql: async (run, body) => ({ body, creates: [], ...graphql }),
  });
  const { secret, notes } = gw.register({ mode: "work", push: true, issue: 1 });
  // A pull request's own write: its route's permissions (PULL_WRITE).
  const pull = await gw.call("/api/v3/repos/org/repo/pulls/12", {
    secret,
    method: "PATCH",
    body: '{"title": "T"}',
  });
  assert.equal(pull.status, 403);
  assert.match((await pull.json()).message, /pull_requests: write permission/);
  assert.match(notes.at(-1), /refused the run's GitHub write PATCH .*pulls\/12/);
  const mutation = await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: '{"query": "mutation { x }"}',
  });
  assert.equal(mutation.status, 403);
  assert.match((await mutation.json()).message, /actions: write permission/);
  assert.equal(gw.calls.length, 0);
  // A query, and a write that needs none of them, go on.
  graphql = { write: false, permissions: { actions: "write" } };
  const query = await gw.call("/api/graphql", {
    secret,
    method: "POST",
    body: '{"query": "{ viewer { login } }"}',
  });
  assert.equal(query.status, 200);
  const issue = await gw.call("/api/v3/repos/org/repo/issues/1", {
    secret,
    method: "PATCH",
    body: '{"title": "T"}',
  });
  assert.equal(issue.status, 200);
  assert.equal(gw.calls.length, 2);
});

test("reading CI's checks and statuses is held to checkRead, REST and GraphQL alike", async (t) => {
  const asked = [];
  let refuse = false;
  const gw = await gateway(t, {
    checkRead: async (run, action) => {
      asked.push([run.mode, action]);
      return refuse ? { status: 403, message: "the policies refuse it: no" } : null;
    },
    checkGraphql: async (run, body) => ({
      body,
      write: false,
      creates: [],
      reads: body.includes("statusCheckRollup") ? { checks: "read", statuses: "read" } : {},
    }),
  });
  const { secret, notes } = gw.register({ mode: "brainstorm", issue: 1 });
  const reads = [
    "/api/v3/repos/org/repo/commits/abc/check-runs",
    "/api/v3/repos/org/repo/commits/feature%2Fx/check-suites",
    "/api/v3/repos/org/repo/commits/abc/status",
    "/api/v3/repos/org/repo/commits/abc/statuses?per_page=100",
    "/api/v3/repos/org/repo/check-runs/12",
    "/api/v3/repos/org/repo/check-suites/3/check-runs",
    "/api/v3/repositories/12/statuses/abc",
  ];
  for (const path of reads) assert.equal((await gw.call(path, { secret })).status, 200, path);
  const graphql = (query) =>
    gw.call("/api/graphql", { secret, method: "POST", body: JSON.stringify({ query }) });
  assert.equal((await graphql("{ statusCheckRollup }")).status, 200);
  assert.equal(asked.length, reads.length + 1);
  assert.deepEqual(asked[0], ["brainstorm", "read_checks"]);
  // Other reads aren't asked.
  assert.equal((await gw.call("/api/v3/repos/org/repo/commits/abc", { secret })).status, 200);
  assert.equal((await graphql("{ viewer { login } }")).status, 200);
  assert.equal(asked.length, reads.length + 1);
  // Refused: GitHub's error shape, and the run's log says so.
  refuse = true;
  const calls = gw.calls.length;
  for (const res of [await gw.call(reads[0], { secret }), await graphql("{ statusCheckRollup }")]) {
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      message: "Deckhand: the policies refuse it: no",
    });
  }
  assert.match(notes.at(-1), /refused the run's GitHub call POST \/api\/graphql: the policies/);
  assert.equal(gw.calls.length, calls);
});

test("CI's checks the installation lacks a permission for: REST refused, GraphQL explained", async (t) => {
  const asked = [];
  const rollup = (data, errors) => JSON.stringify({ data, ...(errors && { errors }) });
  let answer = rollup({ repository: { pullRequest: { title: "T", statusCheckRollup: null } } });
  const gw = await gateway(t, {
    lacking: async (repo, wanted) => {
      asked.push(wanted);
      const missing = ["checks", "statuses"]
        .filter((p) => wanted[p])
        .map((p) => `${p}: ${wanted[p]}`);
      return missing.length ? { missing, account: "org", url: "https://github.com/inst/7" } : null;
    },
    checkRead: async () => null,
    checkGraphql: async (run, body) => ({
      body,
      write: false,
      creates: [],
      reads: body.includes("statusCheckRollup") ? { checks: "read", statuses: "read" } : {},
      readPaths: [["repository", "pullRequest", "commits", "nodes", "commit", "statusCheckRollup"]],
    }),
    respond: (req, res) => {
      if (!req.url.endsWith("/graphql")) return false;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer);
      return true;
    },
  });
  const { secret, notes } = gw.register({ mode: "work", push: true });
  // REST: only checks, refused before GitHub, naming the permission.
  const rest = await gw.call("/api/v3/repos/org/repo/commits/abc/check-runs", { secret });
  assert.equal(rest.status, 403);
  assert.match((await rest.json()).message, /^Deckhand: this needs the GitHub App's checks: read /);
  assert.equal(gw.calls.length, 0);
  // GraphQL: `gh pr view` selects the rollup on commits without any check too: it goes on, and
  // GitHub's answer comes back as it was.
  const query = JSON.stringify({ query: "{ statusCheckRollup }" });
  const post = () => gw.call("/api/graphql", { secret, method: "POST", body: query });
  const plain = await post();
  assert.equal(plain.status, 200);
  assert.equal(await plain.text(), answer);
  assert.equal(gw.calls.at(-1).headers["accept-encoding"], "identity");
  // A commit with checks: GitHub refuses those fields, and the refusal names the permissions.
  // Another field's refusal (another repository's data, SAML…) keeps GitHub's message.
  const at = ["repository", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"];
  const forbidden = "Resource not accessible by integration";
  answer = rollup({ repository: { pullRequest: { statusCheckRollup: null } } }, [
    { type: "FORBIDDEN", path: at, message: forbidden },
    { type: "NOT_FOUND", message: "Could not resolve" },
    { type: "FORBIDDEN", path: ["repository", "pullRequest", "projectItems"], message: forbidden },
  ]);
  const refused = await post();
  assert.equal(refused.status, 200);
  const { data, errors } = await refused.json();
  assert.deepEqual(data, { repository: { pullRequest: { statusCheckRollup: null } } });
  assert.match(
    errors[0].message,
    /^Deckhand: this needs the GitHub App's checks: read, statuses: read permission/,
  );
  assert.deepEqual(errors[0].path, at);
  assert.equal(errors[1].message, "Could not resolve");
  assert.equal(errors[2].message, forbidden);
  assert.match(notes.at(-1), /explained GitHub's refusal of POST \/api\/graphql/);
  // REST's path once; each GraphQL read its fields' (a read has no write's own to ask).
  assert.deepEqual(asked, [
    { checks: "read" },
    { checks: "read", statuses: "read" },
    { checks: "read", statuses: "read" },
  ]);
  // Nothing else needs them.
  const other = JSON.stringify({ query: "{ viewer { login } }" });
  assert.equal(
    (await gw.call("/api/graphql", { secret, method: "POST", body: other })).status,
    200,
  );
  assert.equal(gw.calls.length, 3);
});

test("explained: GitHub's refusals of check fields as Deckhand's message, the rest as it was", () => {
  const answer = (value) => Buffer.from(JSON.stringify(value));
  const forbidden = "Resource not accessible by integration";
  const paths = [["repository", "object", "statusCheckRollup"], ["node"]];
  const out = explained(
    answer({
      data: { a: 1 },
      errors: [
        // At a check field, under one (list indices aside), or under a node spread on a check
        // type: explained.
        { message: forbidden, path: ["repository", "object", "statusCheckRollup"] },
        {
          type: "FORBIDDEN",
          message: "x",
          path: ["repository", "object", "statusCheckRollup", "contexts", "nodes", 3, "name"],
        },
        { type: "FORBIDDEN", message: "x", path: ["node", "checkSuite"] },
        // Elsewhere, above one, without a path, or not a refusal: as GitHub sent it.
        { message: forbidden, path: ["repository", "pullRequest", "projectItems"] },
        { message: forbidden, path: ["repository", "object"] },
        { message: forbidden },
        { message: "other", path: ["repository", "object", "statusCheckRollup"] },
      ],
    }),
    "why",
    paths,
  );
  assert.deepEqual(
    JSON.parse(out).errors.map((e) => e.message),
    ["Deckhand: why", "Deckhand: why", "Deckhand: why", forbidden, forbidden, forbidden, "other"],
  );
  assert.deepEqual(JSON.parse(out).data, { a: 1 });
  const elsewhere = answer({ errors: [{ message: forbidden, path: ["repository", "x"] }] });
  assert.equal(explained(elsewhere, "why", paths), null);
  // No paths (none known, or past checkSelections()' cap): GitHub's messages, all of them.
  const there = answer({ errors: [{ message: forbidden, path: paths[0] }] });
  assert.equal(explained(there, "why", null), null);
  assert.equal(explained(there, "why", []), null);
  assert.equal(explained(answer({ data: { a: 1 } }), "why", paths), null);
  assert.equal(explained(Buffer.from("not json"), "why", paths), null);
});

test("readsChecks: check runs and suites and statuses, a commit's or by id", () => {
  for (const path of [
    "repos/org/repo/commits/abc/check-runs",
    "repos/org/repo/commits/a/b/CHECK-SUITES",
    "repos/org/repo/commits/abc/status",
    "repos/org/repo/commits/abc/statuses",
    "repos/org/repo/commits/abc/status/",
    "repos/org/repo/check-runs/1/annotations",
    "repos/org/repo/check-suites/2",
    "repos/org/repo/statuses/abc",
    "repositories/12/commits/abc/check-runs",
  ]) {
    assert.ok(readsChecks(path), path);
  }
  for (const path of [
    "repos/org/repo/commits/abc",
    "repos/org/repo/commits",
    "repos/org/repo/check-runsx",
    "repos/org/repo/statuses",
    "repos/org/repo/actions/runs",
  ]) {
    assert.ok(!readsChecks(path), path);
  }
  // Their permissions: the run's own repository's only, as Actions'; deny_github's read_checks
  // covers any repository's.
  const own = "Org/Repo";
  assert.deepEqual(needed("repos/org/repo/commits/abc/status", {}, own), { statuses: "read" });
  assert.deepEqual(needed("repos/org/repo/commits/a/b/statuses", {}, own), { statuses: "read" });
  assert.deepEqual(needed("repos/org/repo/check-runs/1", {}, own), { checks: "read" });
  assert.deepEqual(needed("repos/org/repo/commits/abc/check-suites", {}, own), { checks: "read" });
  assert.deepEqual(needed("repos/other/repo/check-runs/1", {}, own), {});
  assert.deepEqual(needed("repositories/12/check-runs/1", {}, own), {});
  assert.ok(readsChecks("repos/other/repo/check-runs/1"));
});

test("logStorage: GitHub's log storage and its own host, nothing else", () => {
  for (const host of [
    "productionresultssa8.blob.core.windows.net",
    "pipelines.actions.githubusercontent.com",
    "GITHUB.EXAMPLE.COM",
  ]) {
    assert.equal(logStorage(host, "github.example.com"), true, host);
  }
  for (const host of ["blob.core.windows.net.evil.example", "evil.example", "windows.net"]) {
    assert.equal(logStorage(host, "github.example.com"), false, host);
  }
});

test("each read capability is its token's permission: GitHub enforces what a run reads", async (t) => {
  const gw = await gateway(t);
  const rows = [
    [["pull"], { contents: "read" }],
    [["pull", "read:issues"], { contents: "read", issues: "read" }],
    [["pull", "read:pulls"], { contents: "read", pull_requests: "read" }],
    [["pull", "read:discussions"], { contents: "read", discussions: "read" }],
    [
      ["pull", "read:actions"],
      { contents: "read", actions: "read", checks: "read", statuses: "read" },
    ],
    // What isn't a read gives the token nothing.
    [["pull", "push", "setup", "docker"], { contents: "read" }],
  ];
  for (const [caps, permissions] of rows) {
    const { secret } = gw.register({ mode: "work", push: true, issue: 1, caps });
    const res = await gw.call("/api/v3/repos/org/repo", { secret });
    assert.equal(res.status, 200, caps.join());
    assert.deepEqual(gw.minted.at(-1)[1], { metadata: "read", ...permissions }, caps.join());
  }
  // None: nothing from GitHub, its writes neither.
  const none = gw.register({ mode: "work", push: true, issue: 1, caps: [] });
  const minted = gw.minted.length;
  for (const [path, method] of [
    ["/api/v3/repos/org/repo", "GET"],
    ["/api/v3/repos/org/repo/issues/1/comments", "POST"],
  ]) {
    const res = await gw.call(path, {
      secret: none.secret,
      method,
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).message, /gets nothing from GitHub: it doesn't have `pull`/);
  }
  assert.equal(gw.minted.length, minted);
});

test("without read:actions: a read of CI is refused naming the capability, not the App", async (t) => {
  const gw = await gateway(t, {
    lacking: async () => ({ missing: ["actions: read"], account: "org", url: null }),
  });
  const { secret, notes } = gw.register({ caps: ["pull", "read:issues"] });
  for (const path of ["actions/runs/1/logs", "commits/abc/check-runs", "commits/abc/status"]) {
    const res = await gw.call(`/api/v3/repos/org/repo/${path}`, { secret });
    assert.equal(res.status, 403, path);
    assert.match(
      (await res.json()).message,
      /^Deckhand: this run's capabilities don't give `read:actions`, which this reads with/,
      path,
    );
  }
  assert.match(notes.at(-1), /read:actions/);
  assert.equal(gw.calls.length, 0);
});

test("without read:issues: its own issue over REST, with a token that reads issues for it alone", async (t) => {
  const gw = await gateway(t);
  const caps = ["pull", "read:pulls"];
  const { secret, notes } = gw.register({ mode: "analyze", issue: 7, caps });
  const get = (path) => gw.call(`/api/v3/${path}`, { secret });
  for (const path of [
    "repos/org/repo/issues/7",
    "repos/Org/Repo/issues/7/comments?per_page=100&page=2",
  ]) {
    assert.equal((await get(path)).status, 200, path);
    assert.equal(gw.minted.at(-1)[1].issues, "read", path);
  }
  // Anything else of its repository: no issues in its token.
  assert.equal((await get("repos/org/repo/pulls/7")).status, 200);
  assert.equal(gw.minted.at(-1)[1].issues, undefined);
  // A list, a search, another issue, its issue by the repository's id, an issue's events:
  // refused, saying why.
  const sent = gw.calls.length;
  for (const path of [
    "repos/org/repo/issues?state=open",
    "search/issues?q=repo:org/repo+secret",
    "repos/org/repo/issues/8",
    "repos/org/repo/issues/70",
    "repos/org/repo/issues/7/events",
    "repos/org/repo/issues/comments/12",
    "repos/other/repo/issues/7",
    "repositories/1/issues/7",
    "repos/org/repo/events",
    "repositories/1/events",
    "networks/org/repo/events",
    "orgs/org/events",
  ]) {
    const res = await get(path);
    assert.equal(res.status, 403, path);
    assert.equal(
      (await res.json()).message,
      "Deckhand: this run's capabilities don't give `read:issues`: it reads its own issue (#7) only",
      path,
    );
  }
  assert.equal(gw.calls.length, sent);
  assert.match(notes.at(-1), /read:issues/);
  // A review is still refused its thread, its own issue's comments too.
  const review = gw.register({ mode: "review", issue: 7, caps });
  const thread = await gw.call("/api/v3/repos/org/repo/issues/7/comments", {
    secret: review.secret,
  });
  assert.equal(thread.status, 403);
  assert.match((await thread.json()).message, /from \$TASK_DIGEST only/);
  // With read:issues: every issue, as GitHub lets its token.
  const all = gw.register({ mode: "analyze", issue: 7, caps: [...caps, "read:issues"] });
  const list = await gw.call("/api/v3/repos/org/repo/issues?state=open", { secret: all.secret });
  assert.equal(list.status, 200);
  assert.equal(gw.minted.at(-1)[1].issues, "read");
});

test("without read:issues: its own issue over GraphQL, anything else of issues refused", async (t) => {
  const checks = createGraphqlChecks({ nodes: async () => [], checkWrite: async () => null });
  const gw = await gateway(t, { checkGraphql: checks.check });
  const { secret } = gw.register({
    mode: "work",
    issue: 7,
    caps: ["pull", "read:pulls"],
  });
  const post = (query, variables) =>
    gw.call("/api/graphql", {
      secret,
      method: "POST",
      body: JSON.stringify({ query, ...(variables && { variables }) }),
    });
  // gh issue view 7: issueOrPullRequest, its number in a variable.
  const view = `query($owner: String!, $repo: String!, $n: Int!) {
    repository(owner: $owner, name: $repo) {
      hasIssuesEnabled
      issue: issueOrPullRequest(number: $n) {
        __typename
        ... on Issue { number title body comments(first: 100) { nodes { body } } }
        ... on PullRequest { number title }
      }
    }
  }`;
  assert.equal((await post(view, { owner: "org", repo: "repo", n: 7 })).status, 200);
  assert.equal(gw.minted.at(-1)[1].issues, "read");
  // A query that reads no issue: no issues in its token.
  assert.equal(
    (await post('{ repository(owner: "org", name: "repo") { pullRequest(number: 7) { title } } }'))
      .status,
    200,
  );
  assert.equal(gw.minted.at(-1)[1].issues, undefined);
  const minted = gw.minted.length;
  for (const [query, variables] of [
    [view, { owner: "org", repo: "repo", n: 8 }],
    ['{ repository(owner: "org", name: "repo") { issues(first: 5) { totalCount } } }'],
    ['{ search(query: "repo:org/repo secret", type: ISSUE, first: 5) { issueCount } }'],
    ['{ node(id: "I_1") { ... on Issue { title } } }'],
    ['{ repository(owner: "org", name: "repo") { issue(number: 7) { parent { title } } } }'],
    ['{ repository(owner: "other", name: "repo") { issue(number: 7) { title } } }'],
  ]) {
    const res = await post(query, variables);
    assert.equal(res.status, 403, query);
    assert.match(
      (await res.json()).message,
      /this run's capabilities don't give `read:issues`, so it reads its own issue only/,
      query,
    );
  }
  assert.equal(gw.minted.length, minted);
});

test("without read:issues: its own issue's next page, by its repository's id as GitHub links it", async (t) => {
  const asked = [];
  let fails = true;
  const gw = await gateway(t, {
    repoId: async (repo) => {
      asked.push(repo);
      if (fails) throw new Error("GitHub is down");
      return 42;
    },
  });
  const caps = ["pull", "read:pulls"];
  const { secret } = gw.register({ mode: "analyze", issue: 7, caps });
  const get = (path) => gw.call(`/api/v3/${path}`, { secret });
  // The id couldn't be looked up: refused, and asked again next time.
  assert.equal((await get("repositories/42/issues/7/comments?page=2")).status, 403);
  fails = false;
  const page = await get("repositories/42/issues/7/comments?page=2");
  assert.equal(page.status, 200);
  assert.equal(gw.minted.at(-1)[1].issues, "read");
  assert.equal((await get("repositories/42/issues/7")).status, 200);
  // Looked up once it answered: an id never changes.
  assert.deepEqual(asked, ["org/repo", "org/repo"]);
  // Another repository's id, another issue under its own: refused.
  for (const path of ["repositories/43/issues/7/comments", "repositories/42/issues/8/comments"]) {
    const res = await get(path);
    assert.equal(res.status, 403, path);
  }
});

test("without read:issues: a mutation whose answer reads other issues is refused before GitHub", async (t) => {
  const checks = createGraphqlChecks({
    nodes: async () => [
      { __typename: "Issue", number: 7, repository: { nameWithOwner: "Org/Repo" } },
    ],
    checkWrite: async () => null,
  });
  const gw = await gateway(t, { checkGraphql: checks.check });
  const { secret } = gw.register({
    mode: "work",
    push: true,
    issue: 7,
    caps: ["pull", "read:pulls"],
  });
  const post = (query) =>
    gw.call("/api/graphql", { secret, method: "POST", body: JSON.stringify({ query }) });
  const leaky = await post(
    `mutation { addReaction(input: {subjectId: "I_7", content: THUMBS_UP}) { subject {
      ... on Issue { repository { issues(first: 100) { nodes { title body } } } } } } }`,
  );
  assert.equal(leaky.status, 403);
  assert.match((await leaky.json()).message, /don't give `read:issues`/);
  assert.equal(gw.calls.length, 0);
  // What it wrote, its answer: through, with its mode's writes.
  const ok = await post(
    'mutation { addReaction(input: {subjectId: "I_7", content: THUMBS_UP}) { reaction { content } subject { id } } }',
  );
  assert.equal(ok.status, 200);
  assert.equal(gw.minted.at(-1)[1].issues, "write");
});

test("each call relayed is counted: the API's as the proxy's with its rate limit, git's fetches", async (t) => {
  const observed = [];
  const ops = [];
  const gw = await gateway(t, {
    observe: (call) => observed.push(call),
    onGit: (op, result) => ops.push(`${op} ${result}`),
    respond: (req, res) => {
      // Never answered: the sandbox gives up first.
      if (req.url.endsWith("/slow")) return true;
      // Git: a round of negotiation, then the pack (protocol v2's packfile section); a repository
      // GitHub fails.
      if (req.url.startsWith("/down.git/")) return (void res.writeHead(503).end(), true);
      if (req.url.endsWith("/git-upload-pack")) {
        // A pack begun, then GitHub's connection lost.
        if (req.headers["x-test-round"] === "cut") {
          res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
          res.write("0008NAK\n0001000dpackfile\n0009\x01PACK");
          setImmediate(() => res.destroy());
          return true;
        }
        // GitHub's error inside a 200: an object it doesn't have.
        if (req.headers["x-test-round"] === "missing") {
          res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
          res.end("0032ERR upload-pack: not our ref 0123456789abcdef\n");
          return true;
        }
        const last = req.headers["x-test-round"] === "last";
        res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
        res.end(
          last ? "0014acknowledgments\n0008NAK\n0001000dpackfile\n0009\x01PACK" : "0008NAK\n0000",
        );
        return true;
      }
      if (!req.url.startsWith("/api/v3/repos/org/repo/issues")) return false;
      res.writeHead(req.url.endsWith("missing") ? 404 : 200, {
        "content-type": "application/json",
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "4321",
        "x-ratelimit-reset": "1900000000",
      });
      res.end("{}");
      return true;
    },
  });
  const { secret } = gw.register();
  await (await gw.call("/api/v3/repos/org/repo/issues", { secret })).arrayBuffer();
  await (await gw.call("/api/v3/repos/org/repo/issues/missing", { secret })).arrayBuffer();
  await (await gw.call("/org/repo.git/info/refs?service=git-upload-pack", { secret })).text();
  for (const round of ["first", "last", "cut", "missing"]) {
    const pack = await gw.call("/org/repo.git/git-upload-pack", {
      secret,
      method: "POST",
      body: "0000",
      headers: { "x-test-round": round },
    });
    await pack.arrayBuffer().catch(() => {});
  }
  await (await gw.call("/down.git/info/refs?service=git-upload-pack", { secret })).text();
  assert.deepEqual(
    observed.map((o) => [o.caller, o.status, o.headers["x-ratelimit-remaining"], o.authorization]),
    [
      ["proxy", 200, "4321", `token ${TOKEN}`],
      ["proxy", 404, "4321", `token ${TOKEN}`],
    ],
  );
  assert.ok(observed.every((o) => o.seconds >= 0));
  // A fetch is the pack request whose answer carries the pack, not its advertisement nor a
  // round of negotiation (github-forks.test.mjs counts a real client's); one GitHub fails, failed.
  // A pack cut short isn't one come: failed.
  // GitHub's ERR inside a 200: failed too.
  assert.deepEqual(ops, ["fetch ok", "fetch failed", "fetch failed", "fetch failed"]);

  // A call the sandbox gave up on before GitHub answered: counted, without a status.
  const aborted = new AbortController();
  const slow = gw.call("/api/v3/repos/org/repo/slow", { secret, signal: aborted.signal });
  while (!gw.calls.some((c) => c.url.endsWith("/slow"))) await new Promise(setImmediate);
  aborted.abort();
  await assert.rejects(slow);
  while (observed.length < 3) await new Promise(setImmediate);
  assert.deepEqual([observed[2].caller, observed[2].status], ["proxy", null]);
});

test("a fetch Deckhand refuses itself, too many calls at once say, is counted as refused", async (t) => {
  const ops = [];
  const gw = await gateway(t, {
    maxInFlight: 0,
    onGit: (op, result) => ops.push(`${op} ${result}`),
  });
  const { secret } = gw.register();
  const res = await gw.call("/org/repo.git/info/refs?service=git-upload-pack", { secret });
  assert.equal(res.status, 429);
  // An API call refused the same way is no git operation.
  assert.equal((await gw.call("/api/v3/repos/org/repo", { secret })).status, 429);
  assert.deepEqual(ops, ["fetch refused"]);
});

test("packIn: a pack request's answer, pkt-line by pkt-line: its pack, GitHub's error, or neither", () => {
  const pkt = (text) => (text.length + 4).toString(16).padStart(4, "0") + text;
  const read = (...chunks) => {
    const reader = packIn();
    for (const chunk of chunks) reader.push(Buffer.from(chunk, "latin1"));
    return reader.found() ? "pack" : reader.failed() ? "error" : null;
  };
  // v2: acknowledgments, then the packfile section, split anywhere.
  const v2 =
    pkt("acknowledgments\n") + pkt("ready\n") + "0001" + pkt("packfile\n") + pkt("\x01PACK");
  assert.equal(read(v2), "pack");
  assert.equal(read(...v2.match(/[\s\S]{1,3}/g)), "pack");
  // A round of negotiation; ls-refs, even with a ref named for the mark.
  assert.equal(read(pkt("acknowledgments\n") + pkt("NAK\n") + "0000"), null);
  assert.equal(read(pkt(`${"a".repeat(40)} refs/heads/x000dpackfile\n`) + "0000"), null);
  // v0: the pack on side-band 1, or bare after the NAK.
  assert.equal(read(pkt("NAK\n") + pkt("\x01PACK\0\0\0\x02")), "pack");
  assert.equal(read(pkt("NAK\n") + "PACK\0\0\0\x02"), "pack");
  // GitHub's errors: an ERR line, side-band 3.
  assert.equal(read(pkt("ERR upload-pack: not our ref " + "a".repeat(40))), "error");
  assert.equal(read(pkt("NAK\n") + pkt("\x03fatal: out of memory")), "error");
});
