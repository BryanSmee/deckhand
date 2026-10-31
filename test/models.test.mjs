// The models service (../models/, #504): the only one holding the agents' credentials. A
// sandbox's agent call reaches it through the egress proxy, with its agent token and the network
// the proxy vouches it came from; the service checks the token offline, the run's agent claim
// and whether the run still goes (the broker), then adds the credential. Two copies on one store
// are two servers on the same memory store here, a real broker beside them.
import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createBroker } from "../broker/server.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { drain } from "../lib/drain.mjs";
import { redact } from "../lib/redact.mjs";
import { networkCallers } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { keyFolder } from "../lib/tokens.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { loadConfig, withModelCredentials } from "../listener/config.mjs";
import { createModelsService } from "../listener/models-service.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { loginSeal } from "../models/logins.mjs";
import { createModels, credentialNames } from "../models/server.mjs";
import { RECORD_MS } from "../models/runs.mjs";
import { createProxy } from "../proxy/proxy.mjs";
import { listening, serve, tempDir, testKey } from "./helpers.mjs";

// Each service reaches the others at an address of its own, as over a network of its own with
// Docker.
const AT = { orchestrator: "127.0.0.2", proxy: "127.0.0.3", models: "127.0.0.6" };
const KEY = "sk-ant-api03-operator-key-0123456789";

// A provider that answers each call's headers and a first event, then holds the rest until the
// test lets it (`release`).
async function fakeAnthropic(t) {
  const requests = [];
  const held = new Set();
  const { url } = await serve(t, (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) return res.end(JSON.stringify({ data: [] }));
      if (requests.at(-1).headers["x-limit"]) {
        res.writeHead(429, { "anthropic-ratelimit-unified-reset": "1900000000" });
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      held.add(res);
    });
  });
  const release = () => {
    for (const res of held) res.end("data: last\n\n");
    held.clear();
  };
  return { url, requests, held, release };
}

// A call to `port` from `as`'s address: → { status, text, json }. `stream`: the answer as it
// comes, `onData(chunk)`.
function call(port, as, method, path, { headers = {}, body, onData } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: AT[as] ?? as, port, method, path, agent: new Agent(), headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => (chunks.push(c), onData?.(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// fetch() over node:http, whatever HTTP_PROXY the environment sets: the services' addresses
// here (127.0.0.2…) aren't all in its NO_PROXY.
function plainFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: init.method, headers: init.headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

// A broker, and `copies` models services on one store, with `env`'s credentials.
async function setup(t, { env = {}, copies = 1, clock = { now: Date.now() } } = {}) {
  const dir = tempDir(t, "deckhand-models-");
  const key = testKey();
  const broker = createBroker({
    store: openStore("memory:"),
    key,
    callers: createCallers({
      networks: "orchestrator=127.0.0.2/32,proxy=127.0.0.3/32,models=127.0.0.6/32",
    }),
    keysDir: join(dir, "keys"),
  });
  await new Promise((resolve) => broker.server.listen(0, "0.0.0.0", resolve));
  broker.server.unref();
  t.after(() => (broker.server.closeAllConnections(), broker.server.close()));
  const brokerPort = broker.server.address().port;
  const callerOf = (as, audiences) =>
    createBrokerCaller({ url: `http://${AT[as]}:${brokerPort}`, service: as, audiences });

  const fullEnv = { DATA_DIR: dir, ...env };
  const config = loadConfig(fullEnv, undefined, { service: "models" });
  const store = openStore("memory:", { now: () => clock.now });
  const seal = loginSeal(Buffer.alloc(32, 7));
  const started = [];
  for (let i = 0; i < copies; i++) {
    const caller = callerOf("models", ["broker", "runner"]);
    const brokerService = createBrokerService({ caller });
    await brokerService.start();
    t.after(() => brokerService.stop());
    const logs = [];
    const models = createModels({
      env: fullEnv,
      config,
      store,
      seal,
      keys: keyFolder(join(dir, "keys")),
      broker: brokerService,
      caller,
      bound: networkCallers("proxy=127.0.0.3/32,orchestrator=127.0.0.2/32"),
      holder: `copy-${i}`,
      now: () => clock.now,
      log: (line) => logs.push(line),
    });
    await new Promise((resolve) => models.server.listen(0, "0.0.0.0", resolve));
    models.server.unref();
    t.after(() => (models.server.closeAllConnections(), models.server.close()));
    started.push({ ...models, port: models.server.address().port, logs });
  }

  const tokenFor = async (as, aud) => (await callerOf(as, [aud]).header(aud)).slice(7);
  // A run's first tokens, as the orchestrator has the broker sign them.
  const orchestrator = callerOf("orchestrator", ["broker", "models"]);
  async function startRun(id, fields) {
    const res = await orchestrator.call("POST", `/runs/${id}/tokens`, {
      body: { repo: "org/repo", mode: "work", sandbox: "net-1", ...fields },
    });
    assert.equal(res.status, 200, res.body.toString());
    return res.json();
  }
  const endRun = (id) => orchestrator.call("DELETE", `/runs/${id}`);
  // A sandbox's call, as the proxy relays it from `sandbox`.
  async function agentCall(copy, path, agentToken, { sandbox = "net-1", ...options } = {}) {
    const service = await tokenFor("proxy", "models");
    return call(copy.port, "proxy", options.method ?? "POST", path, {
      ...options,
      headers: {
        authorization: `Bearer ${service}`,
        "x-deckhand-run-token": agentToken,
        "x-deckhand-sandbox": sandbox,
        "content-type": "application/json",
        ...options.headers,
      },
      body: options.body ?? "{}",
    });
  }
  const asOrchestrator = async (copy, method, path, options = {}) =>
    call(copy.port, "orchestrator", method, path, {
      ...options,
      headers: { authorization: await orchestrator.header("models"), ...options.headers },
    });
  return { copies: started, startRun, endRun, agentCall, asOrchestrator, tokenFor, clock, dir };
}

test("a Claude Code run's call gets the operator's key in place of its agent token", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: upstream.url } });
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  const res = await ctx.agentCall(ctx.copies[0], "/anthropic/v1/messages", agentToken, {
    onData: () => upstream.release(),
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /data: first[\s\S]*data: last/);
  const [{ headers }] = upstream.requests;
  assert.equal(headers["x-api-key"], KEY);
  // Nothing of Deckhand's own goes on: not the proxy's service token, the run's token, nor the
  // network it vouched for.
  for (const name of ["authorization", "x-deckhand-run-token", "x-deckhand-sandbox"]) {
    assert.equal(headers[name], undefined, name);
  }
});

test("another agent's token, another sandbox's call, an ended run: refused, the provider not called", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, {
    env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: upstream.url, OPENAI_API_KEY: "sk-proj-x" },
  });
  const [copy] = ctx.copies;
  // A Codex run's token: its agent claim says openai.
  const codex = (await ctx.startRun("run-codex", { provider: "openai" })).agentToken;
  const res = await ctx.agentCall(copy, "/anthropic/v1/messages", codex);
  assert.equal(res.status, 503);
  assert.match(res.json.error.message, /not a run of Claude Code/);
  // A Claude run's token from another network than its sandbox's.
  const claude = (await ctx.startRun("run-claude", { provider: "anthropic" })).agentToken;
  const elsewhere = await ctx.agentCall(copy, "/anthropic/v1/messages", claude, {
    sandbox: "net-2",
  });
  assert.equal(elsewhere.status, 403);
  assert.match(elsewhere.json.error.message, /only works from its own sandbox/);
  // The run token, not the agent's: another audience.
  const { token } = await ctx.startRun("run-other", { provider: "anthropic" });
  assert.equal((await ctx.agentCall(copy, "/anthropic/v1/messages", token)).status, 401);
  // Its run ended: refused once the broker's last word is old.
  await ctx.endRun("run-claude");
  ctx.clock.now += RECORD_MS;
  const ended = await ctx.agentCall(copy, "/anthropic/v1/messages", claude);
  assert.equal(ended.status, 401);
  assert.match(ended.json.error.message, /unknown or finished run/);
  assert.equal(upstream.requests.length, 0);
});

test("only the proxy and the orchestrator call it, each its own endpoints", async (t) => {
  const ctx = await setup(t, { env: { ANTHROPIC_API_KEY: KEY } });
  const [copy] = ctx.copies;
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  // No service token: the run's agent token alone opens nothing.
  const bare = await call(copy.port, "proxy", "POST", "/anthropic/v1/messages", {
    headers: { authorization: `Bearer ${agentToken}`, "x-deckhand-sandbox": "net-1" },
    body: "{}",
  });
  assert.equal(bare.status, 401);
  // The proxy's token, from the orchestrator's network.
  const proxyToken = await ctx.tokenFor("proxy", "models");
  const replayed = await call(copy.port, "orchestrator", "GET", "/credentials", {
    headers: { authorization: `Bearer ${proxyToken}` },
  });
  assert.equal(replayed.status, 403);
  // The proxy may not read which credentials it holds, nor their fingerprints.
  const fromProxy = await call(copy.port, "proxy", "GET", "/fingerprints", {
    headers: { authorization: `Bearer ${proxyToken}` },
  });
  assert.equal(fromProxy.status, 403);
  // The orchestrator may.
  const names = await ctx.asOrchestrator(copy, "GET", "/credentials");
  assert.deepEqual(names.json, { names: ["ANTHROPIC_API_KEY"] });
});

test("the orchestrator learns the credentials' names and fingerprints, never their values", async (t) => {
  const ctx = await setup(t, {
    env: { ANTHROPIC_API_KEY: KEY, GEMINI_API_KEY: "AIzaSy-operator-gemini-key-012345" },
  });
  const models = createModelsService({
    urls: `http://${AT.orchestrator}:${ctx.copies[0].port}`,
    token: async () => `Bearer ${await ctx.tokenFor("orchestrator", "models")}`,
    fetch: plainFetch,
  });
  t.after(() => models.stop());
  const names = await models.credentials();
  assert.deepEqual(names, ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"]);
  assert.deepEqual(credentialNames({ ANTHROPIC_API_KEY: KEY, OTHER: "x" }), ["ANTHROPIC_API_KEY"]);
  // What the listener's settings read: the names, set to a placeholder.
  const env = withModelCredentials({ ANTHROPIC_API_KEY: "stale", OPENAI_API_KEY: "old" }, names);
  assert.equal(env.ANTHROPIC_API_KEY, "(held by the models service)");
  assert.equal(env.OPENAI_API_KEY, undefined);
  const raw = await ctx.asOrchestrator(ctx.copies[0], "GET", "/fingerprints");
  assert.ok(!raw.text.includes(KEY));
  await models.start();
  const prints = models.prints();
  assert.equal(prints.length, 1);
  // The listener redacts the key it never had, wherever it shows whole.
  for (const text of [
    `x-api-key: ${KEY}`,
    `{"key":"${KEY}"}`,
    `https://example.com/?key=${KEY}&a=1`,
  ]) {
    const out = redact(text, prints);
    assert.ok(!out.includes(KEY), out);
    assert.match(out, /\[redacted\]/);
  }
  assert.equal(redact("nothing secret here at all", prints), "nothing secret here at all");
  // A part of it cut off (#242), or glued to other characters: found by a whole chunk it holds.
  for (const part of [KEY.slice(3, 34), `${KEY.slice(0, 31)}xyz`]) {
    const out = redact(`invalid key (${part})`, prints);
    assert.equal(out, "invalid key ([redacted])", out);
  }
});

test("a run's API state and the calls refused it reach the orchestrator", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-plan-0123456789",
      ANTHROPIC_BASE_URL: upstream.url,
    },
  });
  const [copy] = ctx.copies;
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  const limited = await ctx.agentCall(copy, "/anthropic/v1/messages", agentToken, {
    headers: { "x-limit": "1" },
  });
  assert.equal(limited.status, 429);
  const refused = await ctx.agentCall(copy, "/anthropic/v1/files", agentToken);
  assert.equal(refused.status, 404);
  const models = createModelsService({
    urls: `http://${AT.orchestrator}:${copy.port}`,
    token: async () => `Bearer ${await ctx.tokenFor("orchestrator", "models")}`,
    fetch: plainFetch,
  });
  t.after(() => models.stop());
  assert.deepEqual(await models.apiOf("run-1"), {
    apiStatus: 429,
    apiReset: 1_900_000_000_000,
    apiError: "Anthropic answered 429",
  });
  const notes = [];
  models.consume({ note: (event) => notes.push(event) });
  while (!notes.length) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(notes[0].run, "run-1");
  assert.match(notes[0].message, /refused the agent's call POST \/anthropic\/v1\/files/);
});

test("two copies: each sets only what its calls changed of a run's API state", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, {
    copies: 2,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-plan-0123456789",
      ANTHROPIC_BASE_URL: upstream.url,
    },
  });
  const [a, b] = ctx.copies;
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  // The plan's limit, through one copy; a refused path, through the other.
  const limited = await ctx.agentCall(a, "/anthropic/v1/messages", agentToken, {
    headers: { "x-limit": "1" },
  });
  assert.equal(limited.status, 429);
  assert.equal((await ctx.agentCall(b, "/anthropic/v1/files", agentToken)).status, 404);
  const state = await ctx.asOrchestrator(b, "GET", "/runs/run-1/api");
  // The limit and its reset stay, for the fallback: the other copy only set why its call failed.
  assert.deepEqual(state.json, {
    apiStatus: 429,
    apiReset: 1_900_000_000_000,
    apiError: "not an Anthropic API path",
  });
});

test("two copies: a streaming call in flight finishes while its copy drains, the other takes new ones", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, {
    copies: 2,
    env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: upstream.url },
  });
  const [old, next] = ctx.copies;
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  let firstSeen;
  const seen = new Promise((resolve) => (firstSeen = resolve));
  const streaming = ctx.agentCall(old, "/anthropic/v1/messages", agentToken, {
    onData: () => firstSeen(),
  });
  await seen;
  // SIGTERM: out of rotation, no new connection, the one in flight goes on.
  old.server.startDraining();
  const drained = drain(old.server, { graceMs: 5_000 });
  const ready = await call(old.port, "proxy", "GET", "/ready").catch((error) => error);
  assert.ok(ready instanceof Error || ready.status === 503);
  // The next copy takes a new call meanwhile.
  const other = ctx.agentCall(next, "/anthropic/v1/models", agentToken, {
    method: "GET",
    body: "",
  });
  assert.equal((await other).status, 200);
  upstream.release();
  const res = await streaming;
  assert.equal(res.status, 200);
  assert.match(res.text, /data: last/);
  assert.equal(await drained, true);
});

test("the Antigravity login's refresh is asked of the runner, as the models service", async (t) => {
  const calls = [];
  const runner = createRunnerClient({
    urls: "http://runner.test",
    token: async (service) => `Bearer token-of-${service}`,
    epoch: () => null,
    fetch: async (url, init) => {
      calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ code: 0, out: "{}", err: "" }));
    },
  });
  assert.deepEqual(await runner.refreshLogin("the file"), { code: 0, out: "{}", err: "" });
  assert.deepEqual(calls, [
    {
      url: "http://runner.test/logins/antigravity/refresh",
      auth: "Bearer token-of-models",
      body: { input: "the file" },
    },
  ]);
});

test("through the egress proxy: an agent's call on the broker's host goes to the models service, vouched for by the proxy", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: upstream.url } });
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  // The listener's broker port, which the agent's base URL names: nothing reaches it.
  const listener = await serve(t, (req, res) => res.writeHead(418).end());
  const proxy = createProxy({
    policy: async (ip, host, { broker } = {}) => ({ allowed: broker === true, sandbox: "net-1" }),
    brokerUrl: listener.url,
    modelsService: {
      url: `http://${AT.proxy}:${ctx.copies[0].port}`,
      header: async () => `Bearer ${await ctx.tokenFor("proxy", "models")}`,
    },
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  const viaProxy = (headers) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "POST",
          path: `${listener.url}/anthropic/v1/messages`,
          headers: { "content-type": "application/json", ...headers },
        },
        (res) => {
          let text = "";
          res.on("data", (d) => ((text += d), upstream.release()));
          res.on("end", () => resolve([res.statusCode, text]));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
  // Claude Code's API key mode: the token in x-api-key; the network the sandbox names ignored.
  const [status, text] = await viaProxy({ "x-api-key": agentToken, "x-deckhand-sandbox": "net-9" });
  assert.equal(status, 200, text);
  assert.equal(upstream.requests[0].headers["x-api-key"], KEY);
  // From a network the token isn't bound to, as the proxy says: refused.
  const other = createProxy({
    policy: async () => ({ allowed: true, sandbox: "net-2" }),
    brokerUrl: listener.url,
    modelsService: {
      url: `http://${AT.proxy}:${ctx.copies[0].port}`,
      header: async () => `Bearer ${await ctx.tokenFor("proxy", "models")}`,
    },
  });
  const otherPort = await listening(other);
  t.after(() => other.close());
  const refused = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: otherPort,
        method: "POST",
        path: `${listener.url}/anthropic/v1/messages`,
        headers: { authorization: `Bearer ${agentToken}` },
      },
      (res) => (res.resume(), res.on("end", () => resolve(res.statusCode))),
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(refused, 403);
  assert.equal(upstream.requests.length, 1);
});
