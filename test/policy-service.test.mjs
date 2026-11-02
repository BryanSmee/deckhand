// The policy service (#501): its HTTP side and table, its engine's servers and checks, the
// listener's client, and two copies through a rolling update. policies.test.mjs has what the
// decisions mean, and tries the forbidden builtins with the real opa through it.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { drain } from "../lib/drain.mjs";
import { issueServiceTokens, serviceGuard, signServiceToken } from "../lib/service-token.mjs";
import { keyFolder, keyId, publishKey } from "../lib/tokens.mjs";
import { createPolicies, DEFAULTS_MS } from "../listener/policies.mjs";
import { policyClient } from "../listener/policy-client.mjs";
import { createEngine, opaErrors } from "../policy-service/engine.mjs";
import { opaBinary, opaServer } from "../policy-service/opa.mjs";
import { createPolicyService, grantsDirOf, ROUTES } from "../policy-service/service.mjs";
import {
  evalResult,
  fakeOpa,
  hasOpa,
  listening,
  localService,
  policyEngineOf,
  tempDir,
} from "./helpers.mjs";

const DENY = 'package deckhand\n\ndeny_merge contains "too big" if input.pr.additions > 400\n';

// The broker's key, published where the service reads it.
function brokerKey(t) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = { privateKey, publicKey, kid: keyId(publicKey) };
  const dir = tempDir(t);
  publishKey(dir, key);
  return { key, dir };
}

// A copy of the service with `engine` on a port of its own → { url, server }.
async function copy(t, engine, keysDir) {
  const guard = serviceGuard({
    service: "policy",
    keys: keyFolder(keysDir),
    routes: ROUTES,
    bound: null,
  });
  const server = createPolicyService({ engine, guard });
  const port = await listening(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${port}`, server };
}

// `body` asked of `engine`, with the digest of its own operator layer, as a caller that read the
// same files sends it.
const evaluateOn = (engine, body) =>
  engine.evaluate({ operatorDigest: engine.operatorDigest(), ...body });

const bearer = (key, sub) => `Bearer ${signServiceToken({ sub, aud: "policy" }, key)}`;

test("the service: probes without a token, the rest by its table, an engine's answers", async (t) => {
  const { key, dir } = brokerKey(t);
  const opa = fakeOpa({ answer: (files, doc) => evalResult(doc.pr.additions > 400 ? ["x"] : []) });
  const engine = policyEngineOf(t, { opa, operator: { "size.rego": DENY } });
  const { url, server } = await copy(t, engine, dir);
  const get = (path, auth, init = {}) =>
    fetch(`${url}${path}`, { ...init, headers: { ...(auth && { authorization: auth }) } });
  assert.equal((await get("/health")).status, 200);
  assert.equal((await get("/ready")).status, 200);
  // No token, another service's audience, a caller the table doesn't name, a path not in it.
  assert.equal((await get("/policies")).status, 401);
  const other = `Bearer ${signServiceToken({ sub: "orchestrator", aud: "github" }, key)}`;
  assert.equal((await get("/policies", other)).status, 401);
  const edge = await get("/policies", bearer(key, "edge"));
  assert.equal(edge.status, 403);
  assert.match((await edge.json()).error, /edge may not GET \/policies/);
  assert.equal((await get("/nope", bearer(key, "orchestrator"))).status, 403);
  // Each caller that decides.
  for (const caller of ["orchestrator", "github", "broker"]) {
    const res = await get("/policies", bearer(key, caller));
    assert.equal(res.status, 200, caller);
  }
  const said = await (await get("/policies", bearer(key, "orchestrator"))).json();
  assert.deepEqual(said.operator, [["size.rego", DENY]]);
  assert.deepEqual(said.errors, { deckhand: null, operator: null });
  const post = (path, body) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: bearer(key, "github") },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const evaluated = await post("/evaluate", {
    operatorDigest: engine.operatorDigest(),
    decision: "merge",
    input: { pr: { additions: 500 } },
  });
  assert.deepEqual(await evaluated.json(), {
    operator: { allow: true, denies: ["x"] },
    error: null,
    errorLayer: null,
  });
  // Without the operator's layer the caller expects, or with another: refused, not evaluated.
  const asked = opa.evals().length;
  for (const operatorDigest of [undefined, null, 5, "0".repeat(64)]) {
    const said = await (
      await post("/evaluate", {
        decision: "merge",
        input: { pr: { additions: 500 } },
        operatorDigest,
      })
    ).json();
    assert.equal(said.operator, undefined, String(operatorDigest));
    assert.match(
      said.error,
      typeof operatorDigest === "string"
        ? /aren't the ones the listener read/
        : /^no operatorDigest/,
    );
    assert.equal(said.mismatch, typeof operatorDigest === "string" ? true : undefined);
  }
  assert.equal(opa.evals().length, asked);
  assert.equal((await post("/evaluate", "not json")).status, 400);
  assert.equal((await post("/evaluate", "[]")).status, 200);
  assert.deepEqual(await (await post("/check", { layer: "repo", files: [] })).json(), {
    errors: [],
  });
  // The runner: a repository's grants only, of the operator's layer (#498).
  const asRunner = (body) =>
    fetch(`${url}/evaluate`, {
      method: "POST",
      headers: { authorization: bearer(key, "runner") },
      body: JSON.stringify({ operatorDigest: engine.operatorDigest(), ...body }),
    });
  const grant = { decision: "grant", input: { grant: "docker", repo: { name: "org/repo" } } };
  assert.equal((await asRunner(grant)).status, 200);
  for (const body of [
    { decision: "merge", input: { pr: { additions: 1 } } },
    { ...grant, repo: [["a.rego", "package deckhand\n"]] },
    { ...grant, repoAllow: true },
  ]) {
    const res = await asRunner(body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.match((await res.json()).error, /the runner asks a repository's grants only/);
  }
  for (const path of ["/capabilities", "/check"]) {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { authorization: bearer(key, "runner") },
      body: "{}",
    });
    assert.equal(res.status, 403, path);
  }
  // Draining: out of rotation for a readiness probe.
  server.draining();
  assert.equal((await get("/ready")).status, 503);
  assert.equal((await get("/health")).status, 200);
});

test("the engine: a decision's name and a repo's file names are checked, a set that doesn't compile refuses once checked", async (t) => {
  const opa = fakeOpa({
    checked: (files) =>
      files["bad.rego"]
        ? {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({
              errors: [
                {
                  message: "unexpected eof",
                  location: { file: "policy/repo/bad.rego", row: 3 },
                },
              ],
            }),
          }
        : { code: 0, stdout: "" },
  });
  const engine = policyEngineOf(t, { opa });
  // Into the query as it is: only a name.
  assert.deepEqual(await evaluateOn(engine, { decision: "merge]} ; x", input: {} }), {
    error: 'no decision "merge]} ; x"',
    errorLayer: null,
  });
  assert.deepEqual(
    await evaluateOn(engine, { decision: "merge", input: {}, repo: [["../x.rego", "package a"]] }),
    { error: 'repo: "../x.rego" isn\'t a policy file', errorLayer: "repo" },
  );
  const bad = { decision: "merge", input: {}, repo: [["bad.rego", "package deckhand\n"]] };
  const failed = { error: "bad.rego:3: unexpected eof", errorLayer: "repo" };
  assert.deepEqual(await evaluateOn(engine, bad), failed);
  assert.deepEqual(await evaluateOn(engine, bad), failed);
  // Checked once: the same files fail the same way until they change.
  assert.equal(opa.calls.filter((c) => c.args[0] === "check").length, 1);
  assert.equal(opa.calls.filter((c) => c.args[0] === "serve").length, 0);
  assert.equal(engine.servers(), 0);
  // Another set: checked, then served.
  const good = { ...bad, repo: [["good.rego", "package deckhand\n"]] };
  assert.deepEqual(await evaluateOn(engine, good), {
    operator: { allow: true, denies: [] },
    repo: { allow: null, denies: [] },
    error: null,
    errorLayer: null,
  });
  assert.equal(engine.servers(), 1);
});

test("the engine: one server per set, the least recently used idle ones stopped past the most", async (t) => {
  // Each query held until released: in use, a server isn't stopped.
  const held = [];
  const opa = fakeOpa();
  const serve = opa.serve;
  const stopped = [];
  opa.serve = async (dir, policies) => {
    const server = await serve(dir, policies);
    const id = opa.calls.filter((c) => c.args[0] === "serve").length;
    return {
      ...server,
      query: async (...args) => {
        if (args[1]?.hold) await new Promise((resolve) => held.push(resolve));
        return server.query(...args);
      },
      stop: () => (stopped.push(id), server.stop()),
    };
  };
  const engine = createEngine({
    opa,
    readOperator: () => new Map(),
    readBuiltIn: () => new Map([["a.rego", "package deckhand\nallow_merge := true\n"]]),
    tmp: tempDir(t),
    maxServers: 2,
  });
  t.after(() => engine.stop());
  const ask = (n, input = {}) =>
    evaluateOn(engine, { decision: "merge", input, repo: [[`r${n}.rego`, "package deckhand\n"]] });
  await ask(1);
  await ask(2);
  // The same set again: its server, not a new one.
  await ask(1);
  assert.equal(opa.calls.filter((c) => c.args[0] === "serve").length, 2);
  // A third: the least recently used (2) stops.
  await ask(3);
  assert.deepEqual(stopped, [2]);
  assert.equal(engine.servers(), 2);
  // One held in use (1), and a fourth: 3 stops, never the one in use.
  const busy = ask(1, { hold: true });
  await new Promise((resolve) => setImmediate(resolve));
  await ask(4);
  assert.deepEqual(stopped, [2, 3]);
  held.shift()();
  assert.equal((await busy).error, null);
  // Stopping the engine stops the rest.
  await engine.stop();
  assert.deepEqual(stopped.sort(), [1, 2, 3, 4]);
});

test("the engine: an opa that doesn't start, dies, or doesn't answer in time refuses", async (t) => {
  const failing = fakeOpa();
  failing.serve = async () => {
    throw new Error("listen unix /tmp/x/opa.sock: address in use");
  };
  const down = policyEngineOf(t, { opa: failing });
  assert.deepEqual(await evaluateOn(down, { decision: "merge", input: {} }), {
    error: "opa didn't start (listen unix /tmp/x/opa.sock: address in use)",
    errorLayer: null,
  });
  // Tried again at the next decision: not remembered as the set's failure.
  await evaluateOn(down, { decision: "merge", input: {} });
  assert.equal(failing.calls.filter((c) => c.args[0] === "check").length, 2);
  // Dies: gone from the pool once it exited, started again.
  const dying = fakeOpa();
  const serve = dying.serve;
  let first = null;
  dying.serve = async (...args) => {
    const server = await serve(...args);
    first ??= server;
    return server;
  };
  const engine = policyEngineOf(t, { opa: dying });
  await evaluateOn(engine, { decision: "merge", input: {} });
  assert.equal(engine.servers(), 1);
  await first.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.servers(), 0);
  assert.equal((await evaluateOn(engine, { decision: "merge", input: {} })).error, null);
  assert.equal(dying.calls.filter((c) => c.args[0] === "serve").length, 2);
  // A query past its time.
  const slow = policyEngineOf(t, { opa: fakeOpa({ answer: () => ({ timedOut: true }) }) });
  assert.deepEqual(await evaluateOn(slow, { decision: "fix", input: {} }), {
    error: "the `fix` rules took more than 2 s",
    errorLayer: null,
  });
  // A stopping engine starts nothing.
  await engine.stop();
  assert.deepEqual(await evaluateOn(engine, { decision: "merge", input: {} }), {
    error: "the policy service is stopping",
    errorLayer: null,
  });
});

test("opaErrors: a server's errors and its one message", () => {
  assert.deepEqual(
    opaErrors(
      JSON.stringify({
        code: "invalid_parameter",
        message: "error(s) occurred while compiling query",
        errors: [
          {
            code: "rego_type_error",
            message: "undefined function data.deckhand_repository.lib.f",
            location: { file: "policy/repo/a.rego", row: 2 },
          },
        ],
      }),
    ),
    {
      text: "a.rego:2: undefined function data.lib.f",
      list: [{ file: "a.rego", layer: "repo", row: 2, message: "undefined function data.lib.f" }],
      cancelled: false,
      parsed: true,
    },
  );
  assert.deepEqual(
    opaErrors(JSON.stringify({ code: "internal_error", message: "x.rego:3: eval_conflict_error" })),
    {
      text: "x.rego:3: eval_conflict_error",
      list: [{ file: null, layer: null, row: null, message: "x.rego:3: eval_conflict_error" }],
      cancelled: false,
      parsed: true,
    },
  );
});

test("the client: a service away is waited for, then refused; its refusals said", async () => {
  let clock = 0;
  const calls = [];
  const client = (answer) =>
    policyClient({
      url: "http://policy:8181/",
      header: async () => "Bearer t",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return answer(calls.length);
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      waitMs: 3000,
      retryMs: 1000,
    });
  const refused = () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  await assert.rejects(
    client(refused).policies(),
    /^Error: the policy service can't be reached \(ECONNREFUSED, for 3 s\)$/,
  );
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "http://policy:8181/policies");
  assert.equal(calls[0].init.headers.authorization, "Bearer t");
  // Refused, then draining (503), then up: one answer.
  calls.length = 0;
  clock = 0;
  const up = client((n) =>
    n === 1
      ? refused()
      : n === 2
        ? new Response("draining", { status: 503 })
        : Response.json({ error: null, operator: { allow: true, denies: [] } }),
  );
  assert.deepEqual(await up.evaluate({ decision: "merge" }), {
    error: null,
    operator: { allow: true, denies: [] },
  });
  assert.equal(JSON.parse(calls[2].init.body).decision, "merge");
  // Anything else fails at once, saying what the service said.
  calls.length = 0;
  await assert.rejects(
    client(() => Response.json({ error: "edge may not POST /check" }, { status: 403 })).compile({}),
    /answered 403: edge may not POST \/check/,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    client(() => {
      throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
    }).policies(),
    /can't be reached \(CERT_HAS_EXPIRED\)/,
  );
});

test("the listener's decisions: an unreachable policy service refuses them, as a policy error", async () => {
  const policies = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: policyClient({
      // Nothing listens there.
      url: "http://127.0.0.1:9",
      header: async () => "Bearer t",
      waitMs: 0,
    }),
  });
  const said = await policies.decide("deny_github", "org/repo", "main", () => ({}));
  assert.equal(said.messages.length, 1);
  assert.match(
    said.messages[0],
    /^policy error: the policies can't be read \(the policy service can't be reached/,
  );
  assert.equal(said.unread, true);
});

test("two copies answer the same decision the same way, and a rolling update fails none", async (t) => {
  const { key, dir } = brokerKey(t);
  // Each copy's opa holds the queries asked with `hold` until released.
  const holds = [];
  const engineOf = () => {
    const opa = fakeOpa({
      answer: (files, doc) => evalResult(doc.pr.additions > 400 ? ["too big"] : []),
    });
    const serve = opa.serve;
    opa.serve = async (...args) => {
      const server = await serve(...args);
      return {
        ...server,
        query: async (query, input, options) => {
          if (input.hold) await new Promise((resolve) => holds.push(resolve));
          return server.query(query, input, options);
        },
      };
    };
    return policyEngineOf(t, { opa, operator: { "size.rego": DENY } });
  };
  const old = await copy(t, engineOf(), dir);
  const next = await copy(t, engineOf(), dir);
  const tokens = issueServiceTokens("orchestrator", ["policy"], key);
  // A Service in front of the copies: the one it sends new connections to.
  let target = old.url;
  const decisions = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: policyClient({
      url: "http://policy",
      header: async () => `Bearer ${tokens.policy}`,
      fetch: (url, init) => fetch(url.replace("http://policy", target), init),
      retryMs: 20,
    }),
  });
  const ask = (additions, hold = false) =>
    decisions.deny("deny_merge", "org/repo", "main", () => ({ pr: { additions }, hold }));
  // Both copies say the same, asked directly.
  for (const url of [old.url, next.url]) {
    target = url;
    assert.deepEqual(await ask(500), ["too big"]);
    assert.deepEqual(await ask(5), []);
  }
  // The update: the next copy is up, the old one drains with a decision in flight, and the
  // decisions made meanwhile, refused by the old one, wait for the next.
  target = old.url;
  const inFlight = ask(500, true);
  while (!holds.length) await new Promise((resolve) => setTimeout(resolve, 5));
  old.server.draining();
  const drained = drain(old.server, { graceMs: 5000 });
  const during = ask(500);
  await new Promise((resolve) => setTimeout(resolve, 50));
  target = next.url;
  holds.shift()();
  assert.deepEqual(await inFlight, ["too big"]);
  assert.deepEqual(await during, ["too big"]);
  assert.equal(await drained, true);
  assert.deepEqual(await ask(5), []);
});

test(
  "the real opa: a server serves its set, and one that doesn't compile doesn't start",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const engine = policyEngineOf(t, {
      opa: opaBinary(),
      operator: {
        "conflict.rego":
          'package deckhand\n\nx := 1 if input.a\nx := 2 if input.a\n\ndeny_merge contains sprintf("%v", [x]) if true\n',
      },
    });
    // An evaluation's error: refused, the server's message said.
    const conflict = await evaluateOn(engine, { decision: "merge", input: { a: true } });
    assert.match(
      conflict.error,
      /eval_conflict_error|complete rules must not produce multiple outputs/,
    );
    assert.deepEqual(await evaluateOn(engine, { decision: "merge", input: {} }), {
      operator: { allow: true, denies: [] },
      error: null,
      errorLayer: null,
    });
    // Served without the check before: opa refuses its own start, saying why.
    const dir = tempDir(t);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "policy"));
    writeFileSync(join(dir, "policy", "bad.rego"), "package deckhand\n\ndeny_merge contains\n");
    await assert.rejects(opaServer()(dir, join(dir, "policy")), /bad\.rego/);
  },
);

test("the engine: a check opa didn't finish isn't remembered as the files' compile error", async (t) => {
  // Killed by a signal (the OOM killer), then fine.
  let killed = true;
  const opa = fakeOpa({
    checked: () =>
      killed ? { code: -1, stdout: "", stderr: "", timedOut: false } : { code: 0, stdout: "" },
  });
  const engine = policyEngineOf(t, { opa });
  const ask = () => evaluateOn(engine, { decision: "merge", input: {} });
  const failed = await ask();
  assert.equal(failed.errorLayer, null);
  assert.match(failed.error, /opa failed/);
  killed = false;
  assert.equal((await ask()).error, null);
  assert.equal(opa.calls.filter((c) => c.args[0] === "check").length, 2);
  // Its output not opa's JSON either, a flag it doesn't know: not the files' error.
  const odd = policyEngineOf(t, {
    opa: fakeOpa({ checked: () => ({ code: 2, stdout: "", stderr: "unknown flag: --x" }) }),
  });
  assert.deepEqual(await evaluateOn(odd, { decision: "merge", input: {} }), {
    error: "unknown flag: --x",
    errorLayer: null,
  });
  assert.equal(
    (await odd.compile({ layer: "operator" })).errors[0].text,
    "policy error: unknown flag: --x",
  );
});

test("grantsDirOf: the environment's, else config.yaml's grants_dir, else the default", () => {
  const files = (map) => (path) => {
    if (path in map) return map[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  const yaml = {
    "/etc/deckhand/config.yaml": "allowed_users: [a]\ngrants_dir: /etc/deckhand/prod\n",
  };
  assert.equal(grantsDirOf({ GRANTS_DIR: "/g" }, files(yaml)), "/g");
  assert.equal(grantsDirOf({}, files(yaml)), "/etc/deckhand/prod");
  assert.equal(grantsDirOf({}, files({})), "/etc/deckhand/grants");
  assert.equal(
    grantsDirOf({ CONFIG_FILE: "/c.yaml" }, files({ "/c.yaml": "grants_dir: /x\n" })),
    "/x",
  );
  assert.equal(
    grantsDirOf({}, files({ "/etc/deckhand/config.yaml": "debounce_ms: 5\n" })),
    "/etc/deckhand/grants",
  );
  // A file named on purpose has to be there, as for the listener.
  assert.throws(() => grantsDirOf({ CONFIG_FILE: "/c.yaml" }, files({})), /reading \/c\.yaml/);
});

test("the listener refuses every decision when the policy service doesn't read its grants folder's policies", async (t) => {
  // The listener's grants folder has the operator's policy/; the service's has none (a folder it
  // doesn't mount, a Kubernetes mount one level off), which it reads as no files at all.
  const mine = tempDir(t);
  mkdirSync(join(mine, "policy"));
  writeFileSync(join(mine, "policy", "size.rego"), DENY);
  const empty = tempDir(t);
  const answer = (files, doc) => evalResult(doc.pr.additions > 400 ? ["too big"] : []);
  const engineIn = (grantsDir) => {
    const opa = fakeOpa({ answer });
    const engine = createEngine({ opa, grantsDir, tmp: tempDir(t) });
    t.after(() => engine.stop());
    return { engine, opa };
  };
  // Each call the listener makes, by route.
  const counted = (engine) => {
    const calls = [];
    const local = localService(engine);
    const service = Object.fromEntries(
      Object.entries(local).map(([name, f]) => [name, (...a) => (calls.push(name), f(...a))]),
    );
    return { service, calls };
  };
  const listener = (service) =>
    createPolicies({
      config: { grantsDir: mine },
      github: async () => new Response("{}", { status: 404 }),
      service,
    });
  const input = () => ({ pr: { additions: 500 } });
  const away = engineIn(empty);
  const refused = listener(counted(away.engine).service);
  const [said] = await refused.deny("deny_merge", "org/repo", "main", input);
  assert.match(
    said,
    /^policy error: the policies can't be read \(the policy service reads other operator policies \(none\) than the listener \(size\.rego\): give both the same grants folder/,
  );
  // Nothing evaluated without the operator's rules.
  assert.equal(away.opa.evals().length, 0);
  // Said at start, and on the config panel.
  assert.match((await refused.checkOperator()).errors[0], /give both the same grants folder/);
  assert.match(
    (await refused.describe("org/repo", "main")).errors[0].text,
    /^the operator's policies can't be read: the policy service reads other operator policies/,
  );
  // The same folder: evaluated, Deckhand's asked once, then one call per decision.
  const same = engineIn(mine);
  const { service, calls } = counted(same.engine);
  const decisions = listener(service);
  assert.deepEqual(await decisions.deny("deny_merge", "org/repo", "main", input), ["too big"]);
  assert.deepEqual(await decisions.deny("deny_merge", "org/repo", "main", input), ["too big"]);
  assert.deepEqual(calls, ["policies", "evaluate", "evaluate"]);
  // A copy of another version answers, Deckhand's defaults changed: the decision's digest isn't
  // its layer's, so Deckhand's are asked again and the decision made once more, never evaluated
  // on files other than those it is attributed to.
  let defaults = new Map([["allow.rego", "package deckhand\n\nallow_merge := true\n"]]);
  const updated = createEngine({
    opa: fakeOpa({ answer }),
    grantsDir: mine,
    readBuiltIn: () => defaults,
    tmp: tempDir(t),
  });
  t.after(() => updated.stop());
  const third = counted(updated);
  const upgraded = listener(third.service);
  assert.deepEqual(await upgraded.deny("deny_merge", "org/repo", "main", input), ["too big"]);
  // createEngine() reads Deckhand's once: another copy, with the next version's.
  const next = createEngine({
    opa: fakeOpa({ answer }),
    grantsDir: mine,
    readBuiltIn: () => new Map([...defaults, ["gh-x.rego", "package deckhand\n"]]),
    tmp: tempDir(t),
  });
  t.after(() => next.stop());
  const local = localService(next);
  for (const name of Object.keys(local)) {
    third.service[name] = (...a) => (third.calls.push(name), local[name](...a));
  }
  third.calls.length = 0;
  assert.deepEqual(await upgraded.deny("deny_merge", "org/repo", "main", input), ["too big"]);
  assert.deepEqual(third.calls, ["evaluate", "policies", "evaluate"]);
});

test("a decision skipped on Deckhand's defaults asks again for them after DEFAULTS_MS: a service of another version is seen", async (t) => {
  const grants = tempDir(t);
  mkdirSync(join(grants, "policy"));
  const ALLOWING = "package deckhand\n\nallow_merge := true\n";
  const NO_MERGE = 'package deckhand\n\ndeny_merge contains "no merges in this version" if true\n';
  // A copy whose Deckhand's defaults are `files`: its opa denies with them when one does.
  const copyWith = (files) => {
    const engine = createEngine({
      opa: fakeOpa({
        answer: (own) => evalResult(own["no-merge.rego"] ? ["no merges in this version"] : []),
      }),
      grantsDir: grants,
      readBuiltIn: () => new Map(Object.entries(files)),
      tmp: tempDir(t),
    });
    t.after(() => engine.stop());
    return localService(engine);
  };
  let current = copyWith({ "allow.rego": ALLOWING });
  const calls = [];
  const service = Object.fromEntries(
    ["policies", "evaluate", "compile"].map((name) => [
      name,
      (...a) => (calls.push(name), current[name](...a)),
    ]),
  );
  let clock = 0;
  const policies = createPolicies({
    config: { grantsDir: grants },
    github: async () => new Response("{}", { status: 404 }),
    service,
    now: () => clock,
  });
  const merge = () => policies.decide("deny_merge", "org/repo", "main", () => ({}));
  // Deckhand's allow.rego alone: skipped, the service asked for its defaults only.
  assert.deepEqual(await merge(), { applied: false, messages: [] });
  assert.deepEqual(calls, ["policies"]);
  // The service is updated: its defaults now refuse merges.
  current = copyWith({ "allow.rego": ALLOWING, "no-merge.rego": NO_MERGE });
  clock += DEFAULTS_MS - 1;
  assert.equal((await merge()).applied, false);
  assert.deepEqual(calls, ["policies"]);
  // Past DEFAULTS_MS: asked again, so the new deny applies.
  clock += 1;
  assert.deepEqual((await merge()).messages, ["no merges in this version"]);
  assert.deepEqual(calls, ["policies", "policies", "evaluate"]);
});

test("the listener refuses every decision while the service has operator policies it hasn't, merges and fixes in a row included", async (t) => {
  // The service's grants folder has a deny_merge; the listener's has no policy/ at all.
  const theirs = tempDir(t);
  mkdirSync(join(theirs, "policy"));
  writeFileSync(join(theirs, "policy", "size.rego"), DENY);
  const mine = tempDir(t);
  const opa = fakeOpa();
  const engine = createEngine({ opa, grantsDir: theirs, tmp: tempDir(t) });
  t.after(() => engine.stop());
  const policies = createPolicies({
    config: { grantsDir: mine },
    github: async () => new Response("{}", { status: 404 }),
    service: localService(engine),
  });
  const input = () => ({ pr: { additions: 500 } });
  // Each one asks again and is refused: none built from Deckhand's files cached by the first,
  // none skipped as if only they applied.
  for (const rule of ["deny_merge", "deny_merge", "deny_fix", "deny_merge"]) {
    const said = await policies.decide(rule, "org/repo", "main", input);
    assert.equal(said.applied, true, rule);
    assert.match(
      said.messages[0],
      /^policy error: the policies can't be read \(the policy service reads other operator policies \(size\.rego\) than the listener \(none\)/,
      rule,
    );
  }
  assert.equal(opa.evals().length, 0);
});

test("the capabilities: each file's rules renamed apart as its set is staged, answered by file, one server for every question", async (t) => {
  const operator = {
    "b.rego": 'package deckhand\n\nallow_capabilities contains "push" if input.mode == "work"\n',
    "a.rego": 'package deckhand\n\nallow_capabilities contains "pull"\n',
    "size.rego": DENY,
  };
  const opa = fakeOpa({ capabilitiesFor: (doc) => (doc.mode === "work" ? ["pull"] : []) });
  const engine = policyEngineOf(t, { opa, operator });
  const listener = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: localService(engine),
  });
  const { results, error } = await listener.capabilityRules("org/repo", "main", {
    work: { mode: "work" },
    review: { mode: "review" },
  });
  assert.equal(error, undefined);
  // The fake's names, as the first file by name's: a.rego.
  assert.deepEqual([...results.work.operator.allow], [["pull", ["a.rego"]]]);
  assert.deepEqual([...results.review.operator.allow], []);
  // Staged with each file's rules under a name of its own, by file name, and their union apart;
  // the other files as they are.
  const [served] = opa.calls.filter((c) => c.args[0] === "serve");
  assert.match(served.written.operator["a.rego"], /^allow_capabilities__0 contains "pull"$/m);
  assert.match(served.written.operator["b.rego"], /^allow_capabilities__1 contains "push"/m);
  assert.equal(served.written.operator["size.rego"], DENY);
  assert.equal(
    readFileSync(join(served.cwd, "policy", "operator", "capabilities", "union.rego"), "utf8"),
    "package deckhand\n\n" +
      "allow_capabilities contains c if some c in allow_capabilities__0\n" +
      "allow_capabilities contains c if some c in allow_capabilities__1\n",
  );
  // Both inputs in one query, which asks each file's rules by its index.
  const [query] = opa.evals();
  assert.deepEqual(Object.keys(JSON.parse(query.input)).sort(), ["review", "work"]);
  assert.match(query.query, /allow_capabilities__1\]/);
  // A decision on the same set: the same server.
  assert.deepEqual(
    (await evaluateOn(engine, { decision: "merge", input: { pr: { additions: 1 } } })).operator,
    { allow: true, denies: [] },
  );
  assert.equal(opa.calls.filter((c) => c.args[0] === "serve").length, 1);
});

test("the capabilities: what the engine refuses, and a union's error said as the rules' own", async (t) => {
  const engine = policyEngineOf(t, { opa: fakeOpa() });
  const ask = (body) =>
    engine.evaluateCapabilities({ operatorDigest: engine.operatorDigest(), ...body });
  for (const inputs of [null, [], { run: "x" }, { run: [] }]) {
    assert.match((await ask({ inputs })).error, /^inputs: expected an object/, String(inputs));
  }
  assert.deepEqual(await ask({ inputs: {} }), { results: {} });
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, {}]));
  assert.match((await ask({ inputs: many })).error, /at most 64/);
  const other = await engine.evaluateCapabilities({ inputs: { run: {} }, operatorDigest: "x" });
  assert.equal(other.mismatch, true);
  // A rule that isn't a set breaks the union byFile() wrote: said as such, in its layer.
  const { list } = opaErrors(
    JSON.stringify({
      errors: [
        {
          message: "rego_type_error: undefined ref",
          location: { file: "/tmp/x/policy/repo/capabilities/union.rego", row: 3 },
        },
        {
          message: "allow_capabilities__2: conflicting rules",
          location: { file: "/tmp/x/policy/operator/caps.rego", row: 4 },
        },
        // The operator's union, in a temp folder whose path holds `/repo/`.
        {
          message: "rego_type_error: undefined ref",
          location: { file: "/srv/repo/tmp/x/policy/operator/capabilities/union.rego", row: 2 },
        },
      ],
    }),
  );
  assert.deepEqual(list, [
    {
      file: null,
      layer: "repo",
      row: null,
      message: "`allow_capabilities` and `deny_capabilities` must be sets (`contains` rules)",
    },
    {
      file: "caps.rego",
      layer: "operator",
      row: 4,
      message: "allow_capabilities: conflicting rules",
    },
    {
      file: null,
      layer: "operator",
      row: null,
      message: "`allow_capabilities` and `deny_capabilities` must be sets (`contains` rules)",
    },
  ]);
  // The deciders', but the runner's: it asks the grants alone (#498).
  assert.deepEqual(
    ROUTES["POST /capabilities"],
    ROUTES["POST /evaluate"].filter((caller) => caller !== "runner"),
  );
  assert.ok(ROUTES["GET /policies"].includes("runner"));
  assert.ok(!ROUTES["POST /check"].includes("runner"));
});

test("the capabilities of many modes: in parts the service takes, one answer", async (t) => {
  const engine = policyEngineOf(t, { opa: fakeOpa({ capabilitiesFor: () => ["pull"] }) });
  const local = localService(engine);
  const sizes = [];
  const service = {
    ...local,
    evaluateCapabilities: (body) => (
      sizes.push(Object.keys(body.inputs).length),
      local.evaluateCapabilities(body)
    ),
  };
  const listener = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service,
  });
  const inputs = Object.fromEntries(
    Array.from({ length: 70 }, (_, i) => [`m${i}`, { mode: "work" }]),
  );
  const { results, error } = await listener.capabilityRules("org/repo", "main", inputs);
  assert.equal(error, undefined);
  assert.deepEqual(sizes, [64, 6]);
  assert.equal(Object.keys(results).length, 70);
});

test("the capabilities: a service whose operator layer isn't the one read is asked again once, as decisions are", async (t) => {
  const engine = policyEngineOf(t, { opa: fakeOpa({ capabilitiesFor: () => ["pull"] }) });
  const local = localService(engine);
  const calls = [];
  let mismatches = 1;
  const service = {
    ...local,
    policies: () => (calls.push("policies"), local.policies()),
    evaluateCapabilities: (body) => {
      calls.push("capabilities");
      // A copy of the service with other defaults, once (an update going on).
      if (mismatches-- > 0) return { error: "other operator policies", mismatch: true };
      return local.evaluateCapabilities(body);
    },
  };
  const listener = createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service,
  });
  const { results, error } = await listener.capabilityRules("org/repo", "main", { run: {} });
  assert.equal(error, undefined);
  assert.deepEqual([...results.run.operator.allow.keys()], ["pull"]);
  // Deckhand's policies asked again between the two.
  assert.deepEqual(calls, ["policies", "capabilities", "policies", "capabilities"]);
  // Twice in a row: refused, the start says why.
  mismatches = 2;
  const refused = await listener.capabilityRules("org/repo", "main", { run: {} });
  assert.match(refused.error, /^policy error: other operator policies/);
});
