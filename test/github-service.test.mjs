// The github service (#502, ../github/service.mjs): the App's key and installation tokens in it
// alone; the runs' gateways, the listener's own GitHub calls, the runner's tarballs, each route
// to its callers only; two copies on one store agreeing on a run's state, its calls in flight,
// the epoch and the idempotency keys.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { networkCallers, signServiceToken } from "../lib/service-token.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";
import { RUN_AUTH_HEADER, SANDBOX_HEADER } from "../lib/broker-client.mjs";
import { openStore } from "../lib/store.mjs";
import { createAppHolder } from "../github/app.mjs";
import { createGithubClient } from "../github/client.mjs";
import { githubMetrics } from "../github/metrics.mjs";
import { createRuns, SLOT_MS, STREAM } from "../github/runs.mjs";
import { createRegistry } from "../lib/metrics.mjs";
import { createGithubService, GITHUB_STATUS, mutates } from "../github/service.mjs";
import { fingerprint, fingerprintRedactor } from "../lib/fingerprints.mjs";
import { fingerprints } from "../lib/redact.mjs";
import { loadConfig } from "../listener/config.mjs";
import {
  allowingPolicies,
  assertHealth,
  localBroker,
  serve,
  tempDir,
  testKey,
} from "./helpers.mjs";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

// A fake GitHub (on GitHub Enterprise Server's layout, its API under /api/v3): every call in
// `calls`; `answer(req, body)` → [status, value] or nothing for a 200 with { url }.
async function fakeGitHub(t, answer = () => null) {
  const calls = [];
  const github = await serve(t, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      // org/gone: out of the App's reach; org/down: GitHub failing on its installation.
      if (req.url.endsWith("/repos/org/gone/installation")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Not Found" }));
      }
      // org/limited: a secondary rate limit, which sends no header; org/blocked: a plain 403.
      if (req.url.endsWith("/repos/org/limited/installation")) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "You have exceeded a secondary rate limit." }));
      }
      if (req.url.endsWith("/repos/org/blocked/installation")) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "Repository access blocked" }));
      }
      if (req.url.endsWith("/repos/org/down/installation")) {
        res.writeHead(502, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (req.url.endsWith("/installation")) return res.end(JSON.stringify({ id: 7 }));
      if (req.url.endsWith("/access_tokens")) {
        const expires_at = new Date(Date.now() + 3600_000).toISOString();
        return res.end(
          JSON.stringify({ token: "ghs_installationtoken0123456789abcdefABCDEF", expires_at }),
        );
      }
      const found = await answer(req, body);
      if (found) {
        const [status, value] = found;
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(value === undefined ? undefined : JSON.stringify(value));
      }
      res.writeHead(200, { "content-type": "application/json", link: "<next>; rel=next" });
      res.end(JSON.stringify({ url: req.url }));
    });
  });
  return { ...github, calls };
}

// A github service (one copy) on `store`, the App's key in its own folder, the broker's key
// `key`. `bound`: its callers' networks (none: the network isn't checked).
async function service(
  t,
  github,
  {
    store,
    key,
    bound = null,
    gatewayOptions,
    app = true,
    env = {},
    lateKeys = false,
    brokerReady,
    // ../github/metrics.mjs githubMetrics()'s hooks: its App's calls counted too.
    metrics,
  } = {},
) {
  const dir = tempDir(t);
  if (app) {
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({ id: 5, slug: "deckhand-x", client_id: "Iv1.x", bot_id: 77, pem: PEM }),
    );
  }
  const config = loadConfig(
    { GITHUB_API: `${github.url}/api/v3`, GITHUB_URL: github.url, DATA_DIR: dir, ...env },
    undefined,
    { service: "github" },
  );
  // `lateKeys`: the broker's keys not read yet, as at a first start: read on a key unknown.
  const keys = new Map(lateKeys ? [] : [[key.kid, key.publicKey]]);
  const unknownKey = async () => void keys.set(key.kid, key.publicKey);
  const made = createGithubService({
    config,
    store,
    app: createAppHolder({
      dir,
      api: `${github.url}/api/v3`,
      ...(metrics && { fetch: metrics.fetch }),
    }),
    broker: { keys: () => keys, serviceKeys: () => keys, unknownKey, ready: brokerReady },
    bound,
    policies: allowingPolicies,
    mirrorDir: join(dir, "mirrors"),
    gatewayOptions,
    ...(metrics && { metrics }),
  });
  made.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => made.server.once("listening", resolve));
  t.after(() => (made.server.closeAllConnections(), made.server.close()));
  return { ...made, url: `http://127.0.0.1:${made.server.address().port}`, dir };
}

// Two copies of the service on one store, the broker's key, and a fake GitHub.
async function setup(t, { answer, gatewayOptions, bound, env, metrics } = {}) {
  const github = await fakeGitHub(t, answer);
  const store = openStore("memory:");
  const key = testKey();
  const a = await service(t, github, { store, key, gatewayOptions, bound, env, metrics });
  const b = await service(t, github, { store, key, gatewayOptions, bound, env });
  const as = (sub) => `Bearer ${signServiceToken({ sub, aud: "github" }, key)}`;
  // A call to a copy as `sub`, with the orchestrator's epoch on its writes.
  const call = (copy, sub, method, path, { body, headers = {}, epoch = 10 } = {}) =>
    fetch(`${copy.url}${path}`, {
      method,
      headers: {
        authorization: as(sub),
        ...(sub === "orchestrator" && epoch !== "" && { [EPOCH_HEADER]: String(epoch) }),
        ...(body !== undefined && { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // A run, as the orchestrator tells the service, with its run token from the broker's key.
  const broker = localBroker({ key });
  async function run(id, fields = {}) {
    const sandbox = fields.sandbox ?? `net-${id}`;
    const claims = {
      repo: "org/repo",
      mode: "work",
      issue: 12,
      branches: ["issue-12-*"],
      caps: ["pull", "push", "read:issues", "read:pulls"],
      sandbox,
      ...fields,
    };
    const { token } = await broker.issuer.issue(id, claims);
    const put = await call(a, "orchestrator", "PUT", `/runs/${id}`, {
      body: { ...claims, push: true, decided: true, users: ["alice"] },
    });
    assert.equal(put.status, 204);
    return { token, sandbox };
  }
  // A sandbox's call to GitHub's API as the proxy relays it to a copy.
  const relayed = (copy, { token, sandbox }, method, path, body) =>
    fetch(`${copy.url}/relay/127.0.0.1/api/v3${path}`, {
      method,
      headers: {
        authorization: as("proxy"),
        [SANDBOX_HEADER]: sandbox,
        [RUN_AUTH_HEADER]: `token ${token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { github, store, key, a, b, call, run, relayed };
}

test("GET /health: without a token, its start, version and whether it has an App, nothing else", async (t) => {
  const { a } = await setup(t);
  const health = await fetch(`${a.url}/health`);
  assert.equal(health.status, 200);
  assertHealth(await health.json(), { app: true });
});

test("each route takes its callers only: edge reads, the runner gets tarballs, the orchestrator writes", async (t) => {
  const { a, call, github } = await setup(t, {
    answer: (req) => (req.url.includes("/tarball") ? [200, "tar"] : null),
  });
  // Edge reads a repo's config, the dashboard's data: GitHub's answer, its status apart.
  const read = await call(a, "edge", "GET", "/as/org/repo/repos/org/repo/contents/x?ref=main");
  assert.equal(read.status, 200);
  assert.equal(read.headers.get(GITHUB_STATUS), "200");
  assert.equal(read.headers.get("link"), "<next>; rel=next");
  assert.deepEqual(await read.json(), { url: "/api/v3/repos/org/repo/contents/x?ref=main" });
  // Its token: the installation's, never handed out.
  assert.equal(github.calls.at(-1).auth, "Bearer ghs_installationtoken0123456789abcdefABCDEF");
  // Never a write, over REST or GraphQL; nor a token or the App's settings changed.
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const res = await call(a, "edge", method, "/as/org/repo/repos/org/repo/issues/1/comments", {
      body: { body: "x" },
    });
    assert.equal(res.status, 403, method);
  }
  const mutation = { query: "mutation { addComment(input: {}) { clientMutationId } }" };
  assert.equal(
    (await call(a, "edge", "POST", "/graphql/org/repo", { body: mutation })).status,
    403,
  );
  const query = { query: "query { viewer { login } }" };
  assert.equal((await call(a, "edge", "POST", "/graphql/org/repo", { body: query })).status, 200);
  assert.equal((await call(a, "edge", "PUT", "/app", { body: { pem: "x" } })).status, 403);
  assert.equal(
    (await call(a, "edge", "PUT", "/runs/r1", { body: { repo: "org/repo" } })).status,
    403,
  );
  // The runner: a tarball, and nothing else of GitHub's.
  const tar = await call(a, "runner", "GET", "/tarballs/org/repo/main");
  assert.equal(tar.status, 200);
  assert.equal(await tar.text(), '"tar"');
  for (const [method, path] of [
    ["GET", "/as/org/repo/repos/org/repo"],
    ["POST", "/graphql/org/repo"],
    ["GET", "/as-app/app/installations"],
    ["GET", "/app"],
    ["GET", "/events"],
  ]) {
    const body = method === "POST" ? query : undefined;
    assert.equal((await call(a, "runner", method, path, { body })).status, 403, path);
  }
  // The proxy: the sandboxes' calls only.
  assert.equal((await call(a, "proxy", "GET", "/as/org/repo/repos/org/repo")).status, 403);
  assert.equal((await call(a, "proxy", "GET", "/tarballs/org/repo")).status, 403);
  // No token, or one for another service: refused.
  assert.equal((await fetch(`${a.url}/as/org/repo/repos/org/repo`)).status, 401);
  // The orchestrator writes, GitHub's own refusal passed on as its status.
  const wrote = await call(
    a,
    "orchestrator",
    "POST",
    "/as/org/repo/repos/org/repo/issues/1/comments",
    {
      body: { body: "hello" },
    },
  );
  assert.equal(wrote.headers.get(GITHUB_STATUS), "200");
  assert.deepEqual(JSON.parse(github.calls.at(-1).body), { body: "hello" });
  assert.equal(
    (await call(a, "orchestrator", "POST", "/graphql/org/repo", { body: mutation })).status,
    200,
  );
  // As the App, edge redelivers a delivery (#506), and nothing else: no token minted, no
  // webhook changed, no installation removed; the orchestrator, not even that.
  const asApp = (method, path) =>
    github.calls.filter((c) => c.method === method && c.url === `/api/v3${path}`);
  for (const [method, path] of [
    ["POST", "/app/installations/7/access_tokens"],
    ["PATCH", "/app/hook/config"],
    ["DELETE", "/app/installations/7"],
    ["POST", "/app/hook/deliveries/1/attempts/x"],
  ]) {
    // The service mints its own installation tokens there: none more for this call.
    const before = asApp(method, path).length;
    for (const caller of ["edge", "orchestrator"]) {
      const res = await call(a, caller, method, `/as-app${path}`, { body: {} });
      assert.equal(res.status, 403, `${caller}: ${method} ${path}`);
    }
    assert.equal(asApp(method, path).length, before, `${method} ${path} reached GitHub`);
  }
  assert.equal(
    (await call(a, "orchestrator", "POST", "/as-app/app/hook/deliveries/1/attempts")).status,
    403,
  );
  const redelivered = await call(a, "edge", "POST", "/as-app/app/hook/deliveries/1/attempts");
  assert.equal(redelivered.headers.get(GITHUB_STATUS), "200");
  assert.equal(asApp("POST", "/app/hook/deliveries/1/attempts").length, 1);
});

test("with Docker, a caller's token counts only from its own network", async (t) => {
  // Every call here comes from 127.0.0.1: the runner's network, not edge's.
  const { a, call } = await setup(t, {
    bound: networkCallers("runner=127.0.0.0/8,edge+orchestrator=10.0.0.0/24"),
  });
  assert.equal((await call(a, "edge", "GET", "/as/org/repo/repos/org/repo")).status, 403);
  assert.notEqual((await call(a, "runner", "GET", "/tarballs/org/repo")).status, 403);
});

test("the orchestrator's writes carry its epoch: a stale one is refused by both copies", async (t) => {
  const { a, b, call, github } = await setup(t);
  const path = "/as/org/repo/repos/org/repo/issues/1/labels";
  assert.equal((await call(a, "orchestrator", "POST", path, { body: {}, epoch: 20 })).status, 200);
  const before = github.calls.length;
  for (const copy of [a, b]) {
    const stale = await call(copy, "orchestrator", "POST", path, { body: {}, epoch: 19 });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).message, /epoch 19 is stale/);
  }
  // Without one: refused too. Its reads need none, and a newer one goes on.
  const none = await call(a, "orchestrator", "POST", path, { body: {}, epoch: "" });
  assert.equal(none.status, 400);
  assert.equal(github.calls.length, before);
  assert.equal((await call(b, "orchestrator", "GET", path, { epoch: 1 })).status, 200);
  assert.equal((await call(b, "orchestrator", "POST", path, { body: {}, epoch: 21 })).status, 200);
});

test("a write asked twice with the same idempotency key is made once, through either copy", async (t) => {
  let n = 0;
  const { a, b, call, github } = await setup(t, {
    answer: (req) => (req.method === "POST" ? [201, { id: ++n }] : null),
  });
  const path = "/as/org/repo/repos/org/repo/issues/12/comments";
  const ask = (copy, key) =>
    call(copy, "orchestrator", "POST", path, {
      body: { body: "the run's reply" },
      headers: { "idempotency-key": key },
    });
  const first = await ask(a, "run-1:reply");
  assert.equal(first.headers.get(GITHUB_STATUS), "201");
  assert.deepEqual(await first.json(), { id: 1 });
  // The orchestrator's next copy asks again, through the other copy: the first answer.
  const again = await ask(b, "run-1:reply");
  assert.equal(again.headers.get(GITHUB_STATUS), "201");
  assert.equal(again.headers.get("x-deckhand-replayed"), "1");
  assert.deepEqual(await again.json(), { id: 1 });
  const posts = () =>
    github.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments"));
  assert.equal(posts().length, 1);
  // Another key, another write; none, as many as asked.
  await ask(b, "run-2:reply");
  await call(a, "orchestrator", "POST", path, { body: { body: "x" } });
  await call(a, "orchestrator", "POST", path, { body: { body: "x" } });
  assert.equal(posts().length, 4);
});

test("a failed write isn't kept for its key: asked again, it is made again", async (t) => {
  let n = 0;
  const { a, b, call, github } = await setup(t, {
    answer: (req) => (req.method === "POST" ? (++n === 1 ? [502, {}] : [201, { id: n }]) : null),
  });
  const ask = (copy) =>
    call(copy, "orchestrator", "POST", "/as/org/repo/repos/org/repo/issues/12/comments", {
      body: { body: "x" },
      headers: { "idempotency-key": "run-1:reply" },
    });
  assert.equal((await ask(a)).headers.get(GITHUB_STATUS), "502");
  assert.equal((await ask(b)).headers.get(GITHUB_STATUS), "201");
  assert.equal(github.calls.filter((c) => c.url.endsWith("/comments")).length, 2);
});

test("a run's calls: bound to its sandbox, with a token for its repo, its state shared by both copies", async (t) => {
  let reactions = 0;
  const { a, b, run, relayed, call, github } = await setup(t, {
    answer: (req, body) => {
      if (req.method === "POST" && req.url.endsWith("/reactions")) {
        return [201, { id: 900 + ++reactions, content: JSON.parse(body).content }];
      }
      if (req.method === "DELETE") return [204];
      if (req.url === "/api/v3/repos/org/repo/issues/comments/5") {
        return [200, { issue_url: "https://x/repos/org/repo/issues/12", user: { login: "bob" } }];
      }
      return null;
    },
  });
  const r = await run("r1");
  // From another sandbox, or none: refused.
  const elsewhere = await relayed(a, { ...r, sandbox: "net-other" }, "GET", "/repos/org/repo");
  assert.equal(elsewhere.status, 403);
  const read = await relayed(a, r, "GET", "/repos/org/repo");
  assert.equal(read.status, 200);
  assert.match(github.calls.at(-1).auth, /^token ghs_/);
  // Its reaction, added through one copy, is its own in the other: it may take it off there.
  const added = await relayed(a, r, "POST", "/repos/org/repo/issues/comments/5/reactions", {
    content: "+1",
  });
  assert.equal(added.status, 201);
  const removed = await relayed(b, r, "DELETE", "/repos/org/repo/issues/comments/5/reactions/901");
  assert.equal(removed.status, 204);
  // One it didn't add: refused, through either copy.
  const other = await relayed(b, r, "DELETE", "/repos/org/repo/issues/comments/5/reactions/42");
  assert.equal(other.status, 403);
  // The listener's reaction, noted through one copy before GitHub is asked, is never the run's
  // to take off, though the run's came first (GitHub keeps one per user and content).
  const heart = await relayed(a, r, "POST", "/repos/org/repo/issues/comments/5/reactions", {
    content: "heart",
  });
  assert.equal(heart.status, 201);
  const claimed = await call(a, "orchestrator", "PUT", "/reactions", {
    body: { repo: "org/repo", subject: "issue_comment:5", content: "heart", held: true },
  });
  assert.equal(claimed.status, 204);
  const taken = await relayed(b, r, "DELETE", "/repos/org/repo/issues/comments/5/reactions/902");
  assert.equal(taken.status, 403);
  assert.match((await taken.json()).message, /a reaction the listener added there/);
  // Once the listener took its own off, the run's is its own again.
  await call(b, "orchestrator", "PUT", "/reactions", {
    body: { repo: "org/repo", subject: "issue_comment:5", content: "heart", held: false },
  });
  const freed = await relayed(a, r, "DELETE", "/repos/org/repo/issues/comments/5/reactions/902");
  assert.equal(freed.status, 204);
  // The run's state, as the orchestrator reads it at its end, from either copy.
  const state = await (await call(b, "orchestrator", "GET", "/runs/r1")).json();
  assert.deepEqual(state.created, []);
  const ended = await (await call(a, "orchestrator", "DELETE", "/runs/r1")).json();
  assert.deepEqual(ended.state, { created: [], reruns: [] });
  // Ended: its token names nothing any more.
  assert.equal((await relayed(b, r, "GET", "/repos/org/repo")).status, 401);
});

test("the limit of calls in flight holds across both copies", async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { a, b, run, relayed } = await setup(t, {
    answer: async (req) => (req.url.endsWith("/slow") ? (await held, [200, {}]) : null),
    gatewayOptions: { maxInFlight: 1 },
  });
  const r = await run("r1");
  const slow = relayed(a, r, "GET", "/repos/org/repo/slow");
  // Its first call is in flight through one copy: the other refuses a second.
  for (let i = 0; i < 50; i++) {
    const res = await relayed(b, r, "GET", "/repos/org/repo");
    if (res.status === 429) break;
    assert.ok(i < 49, "never refused");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  release();
  assert.equal((await slow).status, 200);
  assert.equal((await relayed(b, r, "GET", "/repos/org/repo")).status, 200);
});

test("the listener's client: GitHub's answers as fetch() gives them, the service's refusals thrown", async (t) => {
  const { a, key, github } = await setup(t, {
    answer: (req) => (req.url.endsWith("/gone") ? [404, { message: "Not Found" }] : null),
  });
  const client = createGithubClient({
    urls: a.url,
    token: async () => `Bearer ${signServiceToken({ sub: "orchestrator", aud: "github" }, key)}`,
    epoch: () => 30,
  });
  const app = client.app({ slug: "deckhand-x", bot_id: 77, webhook_secret: "s" });
  assert.deepEqual(app.identity(), {
    name: "deckhand-x[bot]",
    email: "77+deckhand-x[bot]@users.noreply.github.com",
  });
  const res = await app.request("org/repo", "GET", "/repos/org/repo?x=1");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: "/api/v3/repos/org/repo?x=1" });
  const gone = await app.request("org/repo", "GET", "/repos/org/repo/gone", undefined, [404]);
  assert.equal(gone.status, 404);
  const posted = await app.request("org/repo", "POST", "/graphql", {
    query: "{ viewer { login } }",
  });
  assert.equal(posted.status, 200);
  assert.equal(github.calls.at(-1).url, "/api/v3/graphql");
  assert.equal((await app.asApp("GET", "/app/installations?per_page=100")).status, 200);
  assert.equal(github.calls.at(-1).url, "/api/v3/app/installations?per_page=100");
  // A stale epoch: the service's refusal, not GitHub's.
  const stale = createGithubClient({
    urls: a.url,
    token: async () => `Bearer ${signServiceToken({ sub: "orchestrator", aud: "github" }, key)}`,
    epoch: () => 1,
  });
  await assert.rejects(
    stale.app({}).request("org/repo", "POST", "/repos/org/repo/issues/1/labels", {}),
    (error) => error.status === 409,
  );
  // A repository out of the App's reach: GitHub's 404 on its installation, as the service's
  // refusal; GitHub failing on it stays the service failing (policies.mjs transient(), #785).
  for (const path of ["/repos/org/gone", "/graphql"]) {
    await assert.rejects(
      app.request(
        "org/gone",
        path === "/graphql" ? "POST" : "GET",
        path,
        path === "/graphql" ? { query: "{ viewer { login } }" } : undefined,
      ),
      (error) => error.status === 404,
      path,
    );
  }
  // A 403 that is a rate limit stays a failure; any other, the refusal it is.
  await assert.rejects(
    app.request("org/limited", "GET", "/repos/org/limited"),
    (error) => error.status === 500,
  );
  await assert.rejects(
    app.request("org/blocked", "GET", "/repos/org/blocked"),
    (error) => error.status === 403,
  );
  await assert.rejects(
    app.request("org/down", "GET", "/repos/org/down"),
    (error) => error.status === 500,
  );
  // The App's public parts, never its key.
  const info = await client.setup.info();
  assert.equal(info.slug, "deckhand-x");
  assert.equal(JSON.stringify(info).includes("PRIVATE"), false);
});

test("the App: a listener's key handed over once, never another App's; a setup only without one", async (t) => {
  const github = await fakeGitHub(t);
  const key = testKey();
  const copy = await service(t, github, { store: openStore("memory:"), key, app: false });
  const as = `Bearer ${signServiceToken({ sub: "orchestrator", aud: "github" }, key)}`;
  const put = (body) =>
    fetch(`${copy.url}/app`, {
      method: "PUT",
      headers: { authorization: as, [EPOCH_HEADER]: "5", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // No App yet: its calls wait for one.
  const before = await fetch(`${copy.url}/as/org/repo/repos/org/repo`, {
    headers: { authorization: as },
  });
  assert.equal(before.status, 412);
  assert.equal(
    (await put({ id: 5, slug: "deckhand-x", pem: PEM, webhook_secret: "w" })).status,
    200,
  );
  assert.equal((await put({ id: 6, slug: "other", pem: PEM })).status, 409);
  // What the service keeps: its key, not edge's secrets.
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(join(copy.dir, "app.json"), "utf8"));
  assert.equal(saved.pem, PEM);
  assert.equal(saved.webhook_secret, undefined);
  // /setup's conversion is edge's (#506): the orchestrator's refused, edge's with an App held.
  const manifest = (authorization) =>
    fetch(`${copy.url}/app/manifest`, {
      method: "POST",
      headers: { authorization, [EPOCH_HEADER]: "5", "content-type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
  assert.equal((await manifest(as)).status, 403);
  const asEdge = `Bearer ${signServiceToken({ sub: "edge", aud: "github" }, key)}`;
  assert.equal((await manifest(asEdge)).status, 409);
});

test("tarballs: the runner's, of an allowed repo, streamed from GitHub; nothing else of it", async (t) => {
  const asked = [];
  const { a, call } = await setup(t, {
    env: { ALLOWED_REPOS: "org/*" },
    answer: (req) => {
      asked.push(`${req.method} ${req.url}`);
      if (req.url.includes("missing")) return [404, {}];
      return [200, "tarball"];
    },
  });
  const tarball = (path, sub = "runner") => call(a, sub, "GET", `/tarballs/${path}`);
  const res = await tarball(`org/repo/${encodeURIComponent("feature/x")}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '"tarball"');
  assert.deepEqual(asked, ["GET /api/v3/repos/org/repo/tarball/feature%2Fx"]);
  assert.equal((await tarball("org/missing/main")).status, 404);
  // Without a ref, the default branch's.
  assert.equal((await tarball("org/repo")).status, 200);
  assert.equal(asked.at(-1), "GET /api/v3/repos/org/repo/tarball");
  // Names that would make the API path another one, decoded or not.
  for (const path of [
    `org/x${encodeURIComponent("/../../../user/repos?")}/HEAD`,
    `org/..%2F..%2Fuser/main`,
    `org/repo/${encodeURIComponent("../../user")}`,
    `org/repo/${encodeURIComponent("main?x=1")}`,
    `org/%E0%A4/main`,
  ]) {
    assert.equal((await tarball(path)).status, 400, path);
  }
  // Another owner's repo; edge.
  assert.equal((await tarball("other/repo/main")).status, 403);
  assert.equal((await tarball("org/repo/main", "edge")).status, 403);
  assert.equal(asked.length, 3);
});

test("blobs: a file's blob id for the runner, at a ref or the default branch; plain paths only", async (t) => {
  const asked = [];
  const { a, call } = await setup(t, {
    env: { ALLOWED_REPOS: "org/*" },
    answer: (req) => {
      asked.push(`${req.method} ${req.url}`);
      if (req.url.includes("missing")) return [404, {}];
      return [200, { type: "file", sha: "sha-1" }];
    },
  });
  const blob = (query, sub = "runner") => call(a, sub, "GET", `/blobs/org/repo?${query}`);
  assert.deepEqual(await (await blob("path=docker%2FDockerfile")).json(), { sha: "sha-1" });
  assert.deepEqual(await (await blob("path=Dockerfile&ref=abc")).json(), { sha: "sha-1" });
  assert.deepEqual(asked, [
    "GET /api/v3/repos/org/repo/contents/docker/Dockerfile",
    "GET /api/v3/repos/org/repo/contents/Dockerfile?ref=abc",
  ]);
  assert.equal((await blob("path=../x")).status, 400);
  assert.equal((await blob("path=Dockerfile&ref=..")).status, 400);
  assert.equal((await blob("path=missing")).status, 404);
  assert.equal((await blob("path=Dockerfile", "edge")).status, 403);
});

test("mutates(): what edge may not send over GraphQL", () => {
  assert.equal(mutates("query { viewer { login } }"), false);
  assert.equal(mutates("{ viewer { login } }"), false);
  assert.equal(mutates("mutation { x }"), true);
  assert.equal(mutates("query { a } mutation { b }"), true);
  assert.equal(mutates("subscription { x }"), true);
  assert.equal(mutates("not graphql {"), true);
});

test("a run's slots in flight: renewed while its calls go on, lapsed once their copy stopped", async () => {
  let time = 0;
  const now = () => time;
  const timers = [];
  const store = openStore("memory:", { now });
  const runs = createRuns({
    store,
    now,
    setTimer: (fn) => (timers.push(fn), { unref() {} }),
    clearTimer: () => {},
  });
  const run = { id: "r1" };
  const first = await runs.inFlight.take(run, 2);
  const second = await runs.inFlight.take(run, 2);
  assert.ok(first && second);
  assert.equal(await runs.inFlight.take(run, 2), null);
  // Long calls, renewed (their timers fire) past a slot's lifetime: still counted.
  for (time = 0; time <= 3 * SLOT_MS; time += SLOT_MS / 3) {
    for (const fire of timers.splice(0)) fire();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(await runs.inFlight.take(run, 2), null);
  // One given back: its place, at once; never counted twice, nor below nothing.
  await runs.inFlight.release(run, first);
  await runs.inFlight.release(run, first);
  const third = await runs.inFlight.take(run, 2);
  assert.ok(third);
  assert.equal(await runs.inFlight.take(run, 2), null);
  // Their copy stopped (no renewal): they lapse, and the run's places come back.
  timers.length = 0;
  time += SLOT_MS + 1;
  assert.ok(await runs.inFlight.take(run, 2));
  assert.ok(await runs.inFlight.take(run, 2));
  assert.equal(await runs.inFlight.take(run, 2), null);
});

test("the operator's credentials, redacted from a run's writes by their fingerprints, never held", async (t) => {
  const { a, b, run, relayed, call, github, store } = await setup(t, {
    answer: (req) => (req.method === "POST" ? [201, { id: 1 }] : null),
  });
  const key = "sk-ant-api03-operatorkeyoperatorkey0123456789";
  const sent = await call(a, "orchestrator", "PUT", "/fingerprints", {
    body: fingerprint([key]),
  });
  assert.equal(sent.status, 204);
  // The store has no part of it, nor a print of one.
  const kept = await store.get("fingerprints");
  assert.equal(JSON.stringify(kept).includes(key.slice(0, 16)), false);
  assert.equal(kept.prints.length, 1);
  const r = await run("r1");
  // Through the other copy, which reads them from the store.
  const wrote = await relayed(b, r, "POST", "/repos/org/repo/issues/12/comments", {
    body: `the key is ${key}, in a word:${key}.`,
  });
  assert.equal(wrote.status, 201);
  const { body } = JSON.parse(github.calls.at(-1).body);
  assert.equal(body.includes("operatorkey"), false);
  assert.equal(body, "the key is [redacted], in a word:[redacted].");
});

// The agents' credentials are the models service's (#504): the orchestrator relays its sets of
// fingerprints as they are, which the gateway redacts by too.
test("the models service's fingerprints, relayed by the orchestrator, redact a run's writes too", async (t) => {
  const { a, b, run, relayed, call, github, store } = await setup(t, {
    answer: (req) => (req.method === "POST" ? [201, { id: 1 }] : null),
  });
  const key = "sk-ant-oat01-modelsheldtokenmodelsheld0123456789";
  const sent = await call(a, "orchestrator", "PUT", "/fingerprints", {
    body: { ...fingerprint([]), sets: [fingerprints([key]), { salt: 1 }, "x"] },
  });
  assert.equal(sent.status, 204);
  const kept = await store.get("fingerprints");
  assert.equal(JSON.stringify(kept).includes(key.slice(0, 16)), false);
  assert.equal(kept.sets.length, 1, "what isn't a set is dropped");
  // Through the other copy, which reads them from the store.
  const r = await run("r1");
  const wrote = await relayed(b, r, "POST", "/repos/org/repo/issues/12/comments", {
    body: `the token is ${key}.`,
  });
  assert.equal(wrote.status, 201);
  assert.equal(JSON.parse(github.calls.at(-1).body).body, "the token is [redacted].");
  // Not a list: refused, what was kept stays.
  const bad = await call(a, "orchestrator", "PUT", "/fingerprints", {
    body: { ...fingerprint([]), sets: {} },
  });
  assert.equal(bad.status, 400);
  assert.equal((await store.get("fingerprints")).sets.length, 1);
});

test("fingerprints: a whole secret found wherever it is; never one of its parts, which would give it away", () => {
  const secret = "ya29.a0AfH6SMBx-longgoogletoken_0123456789";
  const prints = fingerprint([secret, "short"]);
  // One print per secret long enough, whole.
  assert.equal(prints.prints.length, 1);
  assert.match(prints.prints[0], new RegExp(`^${secret.length}:`));
  const redact = fingerprintRedactor(prints);
  assert.equal(redact(`token=${secret}&x=1`), "token=[redacted]&x=1");
  assert.equal(redact(`${secret}${secret}`), "[redacted][redacted]");
  // Cut short: not found (the service can't hold its parts).
  assert.equal(redact(secret.slice(0, 30)), secret.slice(0, 30));
  assert.equal(redact("an ordinary sentence, with words."), "an ordinary sentence, with words.");
  // Another salt: another print, the same find.
  assert.equal(fingerprintRedactor(fingerprint([secret]))(secret), "[redacted]");
  assert.equal(fingerprintRedactor(null)("x"), "x");
});

test("a GraphQL write's key: its answer kept once GitHub ran it, not when its errors came with a 200", async (t) => {
  let n = 0;
  const { a, b, call, github } = await setup(t, {
    answer: (req) =>
      req.url.endsWith("/graphql")
        ? ++n === 1
          ? [200, { errors: [{ type: "RATE_LIMITED" }] }]
          : [200, { data: { addDiscussionComment: { comment: { url: `u${n}` } } } }]
        : null,
  });
  const mutation = { query: "mutation { addDiscussionComment(input: {}) { clientMutationId } }" };
  const ask = (copy) =>
    call(copy, "orchestrator", "POST", "/graphql/org/repo", {
      body: mutation,
      headers: { "idempotency-key": "run-1:reply" },
    });
  assert.deepEqual((await (await ask(a)).json()).errors, [{ type: "RATE_LIMITED" }]);
  // Tried again: made, then given again as it was.
  assert.equal((await (await ask(b)).json()).data.addDiscussionComment.comment.url, "u2");
  assert.equal((await (await ask(a)).json()).data.addDiscussionComment.comment.url, "u2");
  assert.equal(github.calls.filter((c) => c.url.endsWith("/graphql")).length, 2);
});

test("a caller's token signed with a key the service hasn't read yet: the broker's keys read again", async (t) => {
  const github = await fakeGitHub(t);
  const key = testKey();
  const copy = await service(t, github, { store: openStore("memory:"), key, lateKeys: true });
  const res = await fetch(`${copy.url}/app`, {
    headers: { authorization: `Bearer ${signServiceToken({ sub: "edge", aud: "github" }, key)}` },
  });
  assert.equal(res.status, 200);
  // Another key altogether: still refused.
  const other = await fetch(`${copy.url}/app`, {
    headers: {
      authorization: `Bearer ${signServiceToken({ sub: "edge", aud: "github" }, testKey())}`,
    },
  });
  assert.equal(other.status, 401);
});

test("an idempotency key is the orchestrator's, for its call alone: edge's query with it changes nothing", async (t) => {
  let n = 0;
  const { a, b, call, github } = await setup(t, {
    answer: (req) => (req.url.endsWith("/graphql") ? [200, { data: { n: ++n } }] : null),
  });
  const ask = (copy, sub, query) =>
    call(copy, sub, "POST", "/graphql/org/repo", {
      body: { query },
      headers: { "idempotency-key": "run-1:reply" },
    });
  // Edge reads with the key a run's reply will carry: nothing kept.
  assert.deepEqual((await (await ask(a, "edge", "query { viewer { login } }")).json()).data, {
    n: 1,
  });
  const reply = "mutation { addDiscussionComment(input: {}) { clientMutationId } }";
  const posted = await ask(b, "orchestrator", reply);
  assert.equal(posted.headers.get("x-deckhand-replayed"), null);
  assert.deepEqual((await posted.json()).data, { n: 2 });
  // The same key on another path is another call.
  const rest = await call(
    a,
    "orchestrator",
    "POST",
    "/as/org/repo/repos/org/repo/issues/1/comments",
    {
      body: { body: "x" },
      headers: { "idempotency-key": "run-1:reply" },
    },
  );
  assert.equal(rest.headers.get("x-deckhand-replayed"), null);
  assert.equal(
    github.calls.filter((c) => c.method === "POST" && !c.url.endsWith("/access_tokens")).length,
    3,
  );
});

test("setup.json, the conversion's answer kept for a lost one: gone once its hour is over", async (t) => {
  const dir = tempDir(t);
  let time = 1_000_000;
  const timers = [];
  const fetch = async (url) =>
    url.endsWith("/conversions")
      ? Response.json({ id: 5, slug: "x", pem: PEM, webhook_secret: "w", client_secret: "c" })
      : Response.json({ id: 77 });
  const holder = () =>
    createAppHolder({
      dir,
      fetch,
      now: () => time,
      setTimer: (fn, ms) => (timers.push({ fn, at: time + ms }), { unref() {} }),
    });
  const app = holder();
  const made = await app.convert("code1");
  assert.equal(made.credentials.webhook_secret, "w");
  assert.ok(existsSync(join(dir, "setup.json")));
  // Asked again within the hour: the same answer.
  time += 30 * 60_000;
  assert.equal((await app.convert("code1")).credentials.webhook_secret, "w");
  // Past it, the timer armed removes the file, with the edge's secrets in it.
  time += 31 * 60_000;
  for (const timer of timers.splice(0)) if (timer.at <= time) timer.fn();
  assert.equal(existsSync(join(dir, "setup.json")), false);
  assert.equal((await app.convert("code1")).status, 409);
});

test("an installation token a run's call used: its fingerprint to the orchestrator, never the token", async (t) => {
  const { a, run, relayed, store } = await setup(t);
  const r = await run("r1");
  assert.equal((await relayed(a, r, "GET", "/repos/org/repo")).status, 200);
  const events = (await store.read(STREAM, "test", { count: 100 })).map((e) => e.event);
  const tokens = events.filter((e) => e.type === "token");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].run, "r1");
  const token = "ghs_installationtoken0123456789abcdefABCDEF";
  assert.equal(JSON.stringify(tokens[0]).includes(token), false);
  assert.equal(fingerprintRedactor(tokens[0].fingerprints)(`a ${token} b`), "a [redacted] b");
  // The same token again: no new event.
  await relayed(a, r, "GET", "/repos/org/repo");
  const again = (await store.read(STREAM, "test", { count: 100 })).filter(
    (e) => e.event.type === "token",
  );
  assert.equal(again.length, 1);
});

test("/ready: out of rotation until the broker answered the copy, and once it drains (#391)", async (t) => {
  const github = await fakeGitHub(t);
  let answered = false;
  const copy = await service(t, github, {
    store: openStore("memory:"),
    key: testKey(),
    brokerReady: () => answered,
  });
  const ready = async () => (await fetch(`${copy.url}/ready`)).status;
  // A new pod whose calls don't get out yet (k3s's NetworkPolicies, a moment after its start).
  assert.equal(await ready(), 503);
  answered = true;
  assert.equal(await ready(), 200);
  copy.server.startDraining();
  assert.equal(await ready(), 503);
});

test("its GitHub calls are counted as their caller's, a run's as the proxy's, by GitHub's status", async (t) => {
  const registry = createRegistry();
  const metrics = githubMetrics(registry);
  const { a, call, run, relayed } = await setup(t, {
    metrics,
    answer: (req) => (req.url.endsWith("/missing") ? [404, { message: "Not Found" }] : null),
  });
  assert.equal((await call(a, "edge", "GET", "/as/org/repo/repos/org/repo")).status, 200);
  await call(a, "edge", "GET", "/as/org/repo/repos/org/repo/missing");
  await call(a, "orchestrator", "POST", "/as/org/repo/repos/org/repo/issues/1/comments", {
    body: { body: "hi" },
  });
  const sandbox = await run("run-1");
  assert.equal((await relayed(a, sandbox, "GET", "/repos/org/repo/issues/12")).status, 200);
  const text = await registry.render();
  const count = (labels) =>
    Number(
      new RegExp(`^deckhand_github_api_calls_total\\{${labels}\\} (\\d+)$`, "m").exec(text)?.[1] ??
        0,
    );
  // Edge's two, and the installation's lookup and token its first one needed (the fake answers
  // 200 to all three).
  assert.equal(count('caller="edge",status="200"'), 3);
  assert.equal(count('caller="edge",status="404"'), 1);
  // The orchestrator's write, with the installation's token edge's call minted.
  assert.equal(count('caller="orchestrator",status="200"'), 1);
  // The run's call, relayed, and the token minted for its repo.
  assert.equal(count('caller="proxy",status="200"'), 2);
  assert.match(text, /^deckhand_github_api_call_duration_seconds_count\{caller="edge"\} 4$/m);
});
