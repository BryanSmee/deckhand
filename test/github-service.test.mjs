// The github service (#502, ../github/service.mjs): the App's key and installation tokens in it
// alone; the runs' gateways, the listener's own GitHub calls, the runner's tarballs, each route
// to its callers only; two copies on one store agreeing on a run's state, its calls in flight,
// the epoch and the idempotency keys.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { networkCallers, signServiceToken } from "../lib/service-token.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";
import { RUN_AUTH_HEADER, SANDBOX_HEADER } from "../lib/broker-client.mjs";
import { openStore } from "../lib/store.mjs";
import { createAppHolder } from "../github/app.mjs";
import { createGithubClient } from "../github/client.mjs";
import { createGithubService, GITHUB_STATUS, mutates } from "../github/service.mjs";
import { loadConfig } from "../listener/config.mjs";
import { allowingPolicies, localBroker, serve, tempDir, testKey } from "./helpers.mjs";

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
async function service(t, github, { store, key, bound = null, gatewayOptions, app = true } = {}) {
  const dir = tempDir(t);
  if (app) {
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({ id: 5, slug: "deckhand-x", client_id: "Iv1.x", bot_id: 77, pem: PEM }),
    );
  }
  const config = loadConfig(
    { GITHUB_API: `${github.url}/api/v3`, GITHUB_URL: github.url, DATA_DIR: dir },
    undefined,
    { service: "github" },
  );
  const keys = new Map([[key.kid, key.publicKey]]);
  const made = createGithubService({
    config,
    store,
    app: createAppHolder({ dir, api: `${github.url}/api/v3` }),
    broker: { keys: () => keys, serviceKeys: () => keys, unknownKey: async () => {} },
    bound,
    policies: allowingPolicies,
    mirrorDir: join(dir, "mirrors"),
    gatewayOptions,
  });
  made.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => made.server.once("listening", resolve));
  t.after(() => (made.server.closeAllConnections(), made.server.close()));
  return { ...made, url: `http://127.0.0.1:${made.server.address().port}`, dir };
}

// Two copies of the service on one store, the broker's key, and a fake GitHub.
async function setup(t, { answer, gatewayOptions, bound } = {}) {
  const github = await fakeGitHub(t, answer);
  const store = openStore("memory:");
  const key = testKey();
  const a = await service(t, github, { store, key, gatewayOptions, bound });
  const b = await service(t, github, { store, key, gatewayOptions, bound });
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
    answer: (req) => {
      if (req.method === "POST" && req.url.endsWith("/reactions")) {
        return [201, { id: 900 + ++reactions, content: "+1" }];
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
  // The listener's reaction, noted before GitHub is asked, is never the run's.
  const claimed = await call(a, "orchestrator", "PUT", "/reactions", {
    body: { repo: "org/repo", subject: "comment:5", content: "heart", held: true },
  });
  assert.equal(claimed.status, 204);
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
  const manifest = await fetch(`${copy.url}/app/manifest`, {
    method: "POST",
    headers: { authorization: as, [EPOCH_HEADER]: "5", "content-type": "application/json" },
    body: JSON.stringify({ code: "abc" }),
  });
  assert.equal(manifest.status, 409);
});

test("mutates(): what edge may not send over GraphQL", () => {
  assert.equal(mutates("query { viewer { login } }"), false);
  assert.equal(mutates("{ viewer { login } }"), false);
  assert.equal(mutates("mutation { x }"), true);
  assert.equal(mutates("query { a } mutation { b }"), true);
  assert.equal(mutates("subscription { x }"), true);
  assert.equal(mutates("not graphql {"), true);
});
