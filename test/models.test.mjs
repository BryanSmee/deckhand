// The models service (../models/, #504): the only one holding the agents' credentials. A
// sandbox's agent call reaches it through the egress proxy, with its agent token and the network
// the proxy vouches it came from; the service checks the token offline, the run's agent claim
// and whether the run still goes (the broker), then adds the credential. Two copies on one store
// are two servers on the same memory store here, a real broker beside them.
import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
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
import { EPOCH_HEADER } from "../lib/service-client.mjs";
import { SANDBOX_URLS } from "../lib/services.mjs";
import { createBrokerService } from "../listener/broker-service.mjs";
import { loadConfig, withModelCredentials } from "../listener/config.mjs";
import { createModelsService } from "../listener/models-service.mjs";
import { fingerprintSalt, loginKey, loginSeal } from "../models/logins.mjs";
import { fingerprints } from "../models/http.mjs";
import {
  createModels,
  credentialNames,
  credentialValues,
  runnerOf,
  unreadableCredentials,
} from "../models/server.mjs";
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
  const salt = fingerprintSalt(Buffer.alloc(32, 7));
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
      salt,
      keys: keyFolder(join(dir, "keys")),
      broker: brokerService,
      caller,
      bound: networkCallers("proxy=127.0.0.3/32,orchestrator=127.0.0.2/32"),
      holder: `copy-${i}`,
      fetch: plainFetch,
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
      headers: { [EPOCH_HEADER]: "1" },
    });
    assert.equal(res.status, 200, res.body.toString());
    return res.json();
  }
  const endRun = (id) =>
    orchestrator.call("DELETE", `/runs/${id}`, { headers: { [EPOCH_HEADER]: "1" } });
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
  return {
    copies: started,
    startRun,
    endRun,
    agentCall,
    asOrchestrator,
    tokenFor,
    clock,
    dir,
    brokerPort,
  };
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

test("a plan's usage, from its answers and its usage call, reaches the orchestrator", async (t) => {
  const asked = [];
  const { url } = await serve(t, (req, res) => {
    asked.push({ url: req.url, headers: req.headers });
    req.resume().on("end", () => {
      if (req.url === "/api/oauth/usage") {
        return res.end(JSON.stringify({ seven_day_opus: { utilization: 60, resets_at: null } }));
      }
      res.writeHead(200, {
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "1900000000",
      });
      res.end("{}");
    });
  });
  const ctx = await setup(t, {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-plan-0123456789", ANTHROPIC_BASE_URL: url },
  });
  const [copy] = ctx.copies;
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  await ctx.agentCall(copy, "/anthropic/v1/messages", agentToken);
  await copy.usage.settled();
  const models = createModelsService({
    urls: `http://${AT.orchestrator}:${copy.port}`,
    token: async () => `Bearer ${await ctx.tokenFor("orchestrator", "models")}`,
    fetch: plainFetch,
  });
  t.after(() => models.stop());
  // The first read is under way: none yet, then the plan's.
  assert.deepEqual(models.plans(), []);
  await models.usageRead();
  const [claude] = models.plans();
  assert.equal(claude.plan, "claude");
  assert.deepEqual(
    claude.windows.map((w) => [w.name, w.used, w.resetsAt]),
    [["5h", 0.25, 1_900_000_000_000]],
  );
  // Read just now by a run: not polled.
  assert.ok(!asked.some((a) => a.url === "/api/oauth/usage"));
  // Long after, with a dashboard open: the plan's usage call, with its token.
  ctx.clock.now += 10 * 60_000;
  const read = await ctx.asOrchestrator(copy, "GET", "/usage?poll=1");
  assert.equal(read.status, 200);
  await copy.usage.settled();
  const polled = asked.find((a) => a.url === "/api/oauth/usage");
  assert.equal(polled.headers.authorization, "Bearer sk-ant-oat01-plan-0123456789");
  const again = await ctx.asOrchestrator(copy, "GET", "/usage");
  assert.deepEqual(
    again.json.plans[0].windows.map((w) => w.name),
    ["7d_opus", "5h"],
  );
  assert.ok(!again.text.includes("oat01"));
  // The proxy may not read it.
  const proxyToken = await ctx.tokenFor("proxy", "models");
  const fromProxy = await call(copy.port, "proxy", "GET", "/usage", {
    headers: { authorization: `Bearer ${proxyToken}` },
  });
  assert.equal(fromProxy.status, 403);
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
    apiError: "Anthropic answered 429",
  });
});

test("two copies: a provider's failure on one stays what the reply quotes, over a path the other refused", async (t) => {
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
  const limited = await ctx.agentCall(a, "/anthropic/v1/messages", agentToken, {
    headers: { "x-limit": "1" },
  });
  assert.equal(limited.status, 429);
  assert.equal((await ctx.agentCall(b, "/anthropic/v1/files", agentToken)).status, 404);
  const state = await ctx.asOrchestrator(a, "GET", "/runs/run-1/api");
  assert.equal(state.json.apiError, "Anthropic answered 429");
});

test("two copies changing the same field in turn: the last call's answer is what's kept", async (t) => {
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
  const limit = () =>
    ctx.agentCall(a, "/anthropic/v1/messages", agentToken, { headers: { "x-limit": "1" } });
  const api = async () => (await ctx.asOrchestrator(b, "GET", "/runs/run-1/api")).json;
  assert.equal((await limit()).status, 429);
  // An answer through the other copy clears the plan's reset.
  const ok = await ctx.agentCall(b, "/anthropic/v1/models", agentToken, {
    method: "GET",
    body: "",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual([(await api()).apiStatus, (await api()).apiReset], [200, null]);
  // The first copy's 429 again, the same values it had set before: written all the same.
  assert.equal((await limit()).status, 429);
  assert.deepEqual([(await api()).apiStatus, (await api()).apiReset], [429, 1_900_000_000_000]);
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

test("the Antigravity login's refresh is asked of the runner, with the models service's token for it", async (t) => {
  const ctx = await setup(t, { env: { ANTHROPIC_API_KEY: KEY } });
  const calls = [];
  // The models service's real broker caller, as models/server.mjs builds it.
  const caller = createBrokerCaller({
    url: `http://${AT.models}:${ctx.brokerPort}`,
    service: "models",
    audiences: ["broker", "runner"],
  });
  const runner = runnerOf({
    urls: "http://runner.test",
    caller,
    fetch: async (url, init) => {
      calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ code: 0, out: "{}", err: "" }));
    },
  });
  assert.deepEqual(await runner.refreshLogin("the file"), { code: 0, out: "{}", err: "" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://runner.test/logins/antigravity/refresh");
  assert.deepEqual(calls[0].body, { input: "the file" });
  // A service token from models for the runner: what the runner's guard checks.
  const claims = JSON.parse(Buffer.from(calls[0].auth.split(".")[1], "base64url"));
  assert.equal(claims.sub, "models");
  assert.equal(claims.aud, "deckhand:service:runner");
});

test("through the egress proxy: an agent's call to the models service's name goes there, vouched for by the proxy", async (t) => {
  const upstream = await fakeAnthropic(t);
  const ctx = await setup(t, { env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: upstream.url } });
  const { agentToken } = await ctx.startRun("run-1", { provider: "anthropic" });
  // The name the agent's base URL has (lib/services.mjs): the proxy alone reads it.
  const named = `${SANDBOX_URLS.models}/anthropic/v1/messages`;
  const proxy = createProxy({
    policy: async (ip, host, { forward } = {}) => ({ allowed: forward === true, sandbox: "net-1" }),
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
          path: named,
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
        path: named,
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

test("two copies give the same fingerprints, the same after a restart: one set for the listener", async (t) => {
  const ctx = await setup(t, { copies: 2, env: { ANTHROPIC_API_KEY: KEY } });
  const [a, b] = await Promise.all(
    ctx.copies.map(async (copy) => (await ctx.asOrchestrator(copy, "GET", "/fingerprints")).json),
  );
  assert.deepEqual(a, b);
  // The salt comes from the key the logins are sealed with: the same for a copy started anew.
  assert.equal(a.salt, fingerprintSalt(Buffer.alloc(32, 7)));
  assert.notEqual(a.salt, fingerprintSalt(Buffer.alloc(32, 8)));
});

test("redacting with fingerprints stays cheap: a few windows hashed per MB, not each one", () => {
  const prints = [fingerprints([KEY, "sk-proj-another-operator-key-0123456789abcdef"])];
  // A megabyte and more of characters a credential is made of: base64, hashes, long paths.
  const text = Array.from({ length: 30_000 }, (_, i) =>
    Buffer.from(`line ${i} of output`).toString("base64").repeat(2),
  ).join(" ");
  assert.ok(text.length > 1_000_000);
  const started = performance.now();
  const out = redact(`${text} ${KEY.slice(2, 33)}`, prints);
  const ms = performance.now() - started;
  assert.ok(out.endsWith(" [redacted]"));
  // What hashing every window took (#504's first fix): 500 ms and more per MB and set.
  assert.ok(ms < 250, `${Math.round(ms)} ms`);
});

// A fake models service's GET /fingerprints for createModelsService(): `answer(n)` for the n-th.
const fingerprintsFetch = (answer) => {
  let n = 0;
  return async (url) => {
    if (!String(url).endsWith("/fingerprints")) return new Response("{}", { status: 404 });
    const value = await answer(++n);
    return value instanceof Response ? value : new Response(JSON.stringify(value));
  };
};

test("the listener's fingerprints: the operator's fixed key stays redacted once refreshed tokens fill the cap", async () => {
  const salt = "s".repeat(32);
  // A plan's access token refreshed at every read, beside a key that never changes.
  const fetch = fingerprintsFetch((n) =>
    fingerprints([KEY, `ya29.${randomBytes(96).toString("base64url")}`], salt),
  );
  const models = createModelsService({
    urls: "http://models.test",
    token: async () => null,
    fetch,
    setTimer: () => ({}),
  });
  const piece = KEY.slice(1, 33);
  for (let i = 0; i < 400; i++) {
    await models.start();
    const out = redact(`key (${piece})`, models.prints());
    assert.equal(out, "key ([redacted])", `read ${i}`);
  }
  assert.ok(models.prints()[0].chunks.length <= 2000);
});

test("the listener's first fingerprints: start() resolves once they are read, not after a failed try", async () => {
  const fetch = fingerprintsFetch((n) =>
    n === 1 ? new Response("down", { status: 500 }) : fingerprints([KEY], "s".repeat(32)),
  );
  const models = createModelsService({
    urls: "http://models.test",
    token: async () => null,
    fetch,
    setTimer: () => ({}),
  });
  await models.start();
  assert.equal(models.prints().length, 1);
  assert.equal(redact(KEY, models.prints()), "[redacted]");
});

test("loginKey(): two copies starting together on an empty volume keep the first one's key", () => {
  const dir = tempDir(null, "deckhand-models-key-");
  let first = null;
  // The other copy links its key in place between this one's read and its link.
  const key = loginKey(dir, { beforeLink: () => (first ??= loginKey(dir)) });
  assert.deepEqual(key, first);
  assert.deepEqual(loginKey(dir), first);
  assert.deepEqual(readdirSync(dir), ["models.key"]);
});

test("loginKey(): made once, then read; the same key for every caller", () => {
  const dir = tempDir(null, "deckhand-models-key-");
  const key = loginKey(dir);
  assert.equal(key.length, 32);
  assert.deepEqual(loginKey(dir), key);
  assert.deepEqual(readdirSync(dir), ["models.key"]);
  assert.equal(statSync(join(dir, "models.key")).mode & 0o777, 0o600);
});

test("a credentials folder or login the models service can't read is said at start, by name", () => {
  const denied = new Set(["/data/credentials/codex-auth.json", "/elsewhere/agy.json"]);
  const access = (path) => {
    if (path === "/data/credentials/agy-auth.json")
      throw Object.assign(new Error(), { code: "ENOENT" });
    if (denied.has(path)) throw Object.assign(new Error(), { code: "EACCES" });
  };
  const lines = unreadableCredentials(
    { DATA_DIR: "/data", AGY_AUTH_FILE: "/elsewhere/agy.json" },
    { access },
  );
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /AGY_AUTH_FILE, \/elsewhere\/agy\.json can't be read \(EACCES\): it runs as uid 1000/,
  );
  assert.match(lines[1], /the login \/data\/credentials\/codex-auth\.json can't be read/);
  // The folder itself: said once, not for each file in it.
  const folder = unreadableCredentials(
    { DATA_DIR: "/data" },
    {
      access: () => {
        throw Object.assign(new Error(), { code: "EACCES" });
      },
    },
  );
  assert.equal(folder.length, 1);
  assert.match(folder[0], /the credentials folder \/data\/credentials/);
  assert.deepEqual(unreadableCredentials({ DATA_DIR: "/data" }, { access: () => {} }), []);
});

test("the plans' login files are no secret: their paths are neither fingerprinted nor redacted", () => {
  const env = {
    ANTHROPIC_API_KEY: KEY,
    CODEX_AUTH_FILE: "/data/credentials/codex-auth.json",
    AGY_AUTH_FILE: "/data/credentials/agy-auth.json",
  };
  assert.deepEqual(credentialValues(env), [KEY]);
  const prints = [fingerprints(credentialValues(env))];
  const text = "reads /data/credentials/agy-auth.json, mounted at /data/credentials:ro.";
  assert.equal(redact(text, prints), text);
});
