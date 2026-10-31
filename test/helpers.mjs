// What the test files share: servers on a port the OS picks, temp dirs that don't outlive
// their test, a config, a fake GitHub's fetch. `node --test` loads it as a file of its own too
// (everything under test/ matches its patterns), where it finds no test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../listener/config.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { keyFolder } from "../lib/tokens.mjs";
import { allowOnly, createEngine } from "../policy-service/engine.mjs";
import { createPolicyService, ROUTES } from "../policy-service/service.mjs";

// Whether the real `opa` is on the PATH (the listener's image has it): the tests that evaluate
// Deckhand's policies as written skip without it, the fakes cover the listener's side. Asked
// once, by those tests only: the other files importing this one don't start a process for it.
let opaFound;
export function hasOpa() {
  if (opaFound === undefined) {
    try {
      execFileSync("opa", ["version"], { stdio: "ignore" });
      opaFound = true;
    } catch {
      opaFound = false;
    }
  }
  return opaFound;
}

// Listens on 127.0.0.1, on a port the OS picks; resolves to that port.
export async function listening(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

// A server answering with `handle(req, res)` (a broker, a proxy, a fake upstream), closed after
// the test: its URL, and the server.
export async function serve(t, handle) {
  const server = createServer(handle);
  const port = await listening(server);
  // Closed after the test, unless a hook before failed (a temp dir that couldn't go): the hooks
  // after a failed one don't run. Unreferenced, it then doesn't keep the file's process alive,
  // which `node --test` would wait for forever (#521); the test's own calls still hold theirs.
  server.unref();
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${port}`, server, port };
}

// A broker's `sentFrom` (broker.mjs) for a sandbox at `address`: the tests' requests come from
// 127.0.0.1, so another address stands for a secret sent from another sandbox.
export function sandboxAt(address = "127.0.0.1") {
  const asked = [];
  const sentFrom = async (run, ip) => (asked.push({ run, ip }), ip === address);
  return Object.assign(sentFrom, { asked });
}

// Retried: a process the test stopped may still be writing there.
const remove = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

// The dirs made without a test go when the test file's process exits.
const leftover = new Set();
process.once("exit", () => {
  for (const dir of leftover) {
    try {
      remove(dir);
    } catch (error) {
      console.error(`Left ${dir}: ${error.message}`);
    }
  }
});

// A new temp dir, removed after `t` (a test, or null for the end of the file: when what the
// test started may outlive it).
export function tempDir(t, prefix = "deckhand-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (t) t.after(() => remove(dir));
  else leftover.add(dir);
  return dir;
}

// The operator's settings with an allowlist (alice), and `overrides`.
export function testConfig(overrides = {}) {
  return loadConfig({ ALLOWED_USERS: "alice", ...overrides });
}

// A fake GitHub's fetch: each call ({ method, path, auth, body }, `path` with its query) goes
// to `calls`, and `answer(call)` answers it: a Response, a value sent as JSON, or nothing for
// a 404.
export function recordingFetch(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const call = {
      method: init.method ?? "GET",
      path: pathname + search,
      auth: init.headers?.authorization,
      body: init.body,
    };
    calls.push(call);
    const answered = await answer(call);
    if (answered instanceof Response) return answered;
    if (answered === undefined) return new Response("Not Found", { status: 404 });
    return Response.json(answered);
  };
  return { fetch, calls };
}

// opa's answer to the query of a layer's rules, as `opa eval` gives it: `deny`, the deny rule's
// value (undefined: no file defines it); `allow`, the allow rule's (null: none defines it).
export const evalResult = (deny, allow = true) => ({
  code: 0,
  stdout: JSON.stringify({
    result: [
      {
        expressions: [
          {
            value: {
              allow: allow === null ? [] : [allow],
              deny: deny === undefined ? [] : [deny],
            },
          },
        ],
      },
    ],
  }),
});

// A fake `opa` for the policy service's engine (../policy-service/engine.mjs). `run` plays its
// short processes: `capabilities` (`capabilities`), `check` (`checked(files)`). `serve` plays its
// servers: each query asks `answer(files, input, layer, query)` for each layer it names (`files`:
// that layer's staged policies, name → text, a repo's as it wrote them, before namespaced()),
// which answers as `opa eval` would ({ code, stdout, stderr, timedOut }: evalResult()), and the
// server answers as opa's does; `queried({ query, input, layers })` hears each query first.
// `calls`: each one, with the staged files; `evals()`: the queries.
export function fakeOpa({
  answer = () => evalResult([]),
  queried = () => {},
  checked = () => ({ code: 0, stdout: "" }),
  capabilities = { builtins: [{ name: "count" }] },
} = {}) {
  const calls = [];
  // Each staged layer's files (policy/operator/, policy/repo/), name → text as written (the
  // repo's namespaced(): `raw`, as the repo wrote them).
  const staged = (cwd, raw) =>
    Object.fromEntries(
      readdirSync(join(cwd, "policy")).map((layer) => [
        layer,
        Object.fromEntries(
          readdirSync(join(cwd, "policy", layer)).map((n) => {
            const text = readFileSync(join(cwd, "policy", layer, n), "utf8");
            return [n, raw ? text.replaceAll("deckhand_repository.", "") : text];
          }),
        ),
      ]),
    );
  const capabilitiesOf = (cwd) => JSON.parse(readFileSync(join(cwd, "capabilities.json"), "utf8"));
  const run = async (args, { input, cwd } = {}) => {
    calls.push({ args, input, cwd });
    if (args[0] === "capabilities") return { code: 0, stdout: JSON.stringify(capabilities) };
    const layers = staged(cwd, true);
    const files = Object.assign({}, ...Object.values(layers));
    Object.assign(calls.at(-1), {
      capabilities: capabilitiesOf(cwd),
      files,
      layers,
      written: staged(cwd),
    });
    return checked(files);
  };
  const serve = async (dir) => {
    const all = staged(dir, true);
    const written = staged(dir);
    calls.push({
      args: ["serve"],
      cwd: dir,
      layers: all,
      written,
      capabilities: capabilitiesOf(dir),
    });
    let done;
    const exited = new Promise((resolve) => (done = resolve));
    return {
      query: async (query, input) => {
        const asked = [...query.matchAll(/"(operator|repo)": \{/g)].map((m) => m[1]);
        const layers = Object.fromEntries(asked.map((l) => [l, all[l] ?? {}]));
        calls.push({
          args: ["eval"],
          query,
          input: JSON.stringify(input),
          cwd: dir,
          layers,
          files: Object.assign({}, ...Object.values(layers)),
          written,
        });
        queried({ query, input, layers });
        const value = {};
        for (const layer of asked) {
          const res = answer(layers[layer], input, layer, query);
          if (res.timedOut) return { timedOut: true };
          if (res.code !== 0) {
            const message = res.stderr || "opa failed";
            return {
              status: 500,
              body: res.stdout || JSON.stringify({ code: "internal_error", message }),
            };
          }
          try {
            value[layer] = JSON.parse(res.stdout).result?.[0]?.expressions?.[0]?.value;
          } catch {
            return { status: 200, body: res.stdout };
          }
        }
        return { status: 200, body: JSON.stringify({ result: [{ result: value }] }) };
      },
      stop: async () => done(0),
      exited,
    };
  };
  return { run, serve, calls, evals: () => calls.filter((c) => c.args[0] === "eval") };
}

// The policy service's engine as the listener sees it through HTTP (policy-client.mjs): each
// request and answer through JSON, so that nothing but what the wire carries gets across.
export function localService(engine) {
  const wire = (value) => JSON.parse(JSON.stringify(value));
  return {
    policies: async () => wire(engine.policies()),
    evaluate: async (body) => wire(await engine.evaluate(wire(body))),
    compile: async (body) => wire(await engine.compile(wire(body))),
  };
}

// The policy service's engine with `opa` (fakeOpa()'s, or the real binary's: opaBinary()),
// stopped after `t`. `operator` and `builtIn`: name → text (builtIn: Deckhand's allow.rego by
// default), or `readOperator()` and `readBuiltIn()`, as createEngine() takes them.
export function policyEngineOf(
  t,
  {
    opa = fakeOpa(),
    operator = {},
    builtIn = null,
    readOperator = () => new Map(Object.entries(operator)),
    readBuiltIn = () => (builtIn ? new Map(Object.entries(builtIn)) : allowOnly()),
  } = {},
) {
  const engine = createEngine({ opa, readOperator, readBuiltIn, tmp: tempDir(t) });
  t.after(() => engine.stop());
  return engine;
}

// The policy service over HTTP (../policy-service/service.mjs), checking the tokens of the keys
// in `keysDir`: its `engine`, else one with Deckhand's policies and the operator's in
// `grantsDir`, and an `opa` that allows everything by default (the real one evaluates them in
// github-writes.test.mjs), what a listener of server.test.mjs calls. Its URL.
export async function servePolicies(
  t,
  { grantsDir = null, keysDir, opa = fakeOpa(), engine = null },
) {
  engine ??= createEngine({ opa, grantsDir, tmp: tempDir(null) });
  const guard = serviceGuard({
    service: "policy",
    keys: keyFolder(keysDir),
    routes: ROUTES,
    bound: null,
  });
  const server = createPolicyService({ engine, guard });
  const port = await listening(server);
  server.unref();
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await engine.stop();
  });
  return `http://127.0.0.1:${port}`;
}

// `res`, `opa eval`'s answer to a query of both layers ({ value: { operator, repo } }), as one
// `layer` would answer alone; anything else as it is.
function layerOf(res, layer) {
  let value;
  try {
    value = JSON.parse(res.stdout).result[0].expressions[0].value;
  } catch {
    return res;
  }
  if (!value || typeof value !== "object" || !(layer in value)) return res;
  return {
    code: 0,
    stdout: JSON.stringify({ result: [{ expressions: [{ value: value[layer] }] }] }),
  };
}

// The policies (policies.mjs) over the policy service's engine with a fake `opa` and org/repo's
// policy `files` (name → text) on `ref`, the operator's `operator` (likewise, over Deckhand's
// allow.rego): each layer allows, its deny rule says `messages(input, rule, names)` (names: that
// layer's files), or it fails as `failure` says; `listFails()`, a status GitHub answers the
// repo's policy folder with instead (null: none). `evals`: the inputs it was asked about (one
// query each), with their `rule`; `layers`, each one's file names, both layers'.
export function policyEngine(
  t,
  {
    files = null,
    operator = {},
    messages = () => [],
    failure = null,
    ref = "main",
    listFails = () => null,
  } = {},
) {
  const evals = [];
  // Each evaluation's files, by name, as `evals`.
  const layers = [];
  const ruleOf = (query) => `deny_${/\.deny_(\w+)\]/.exec(query)[1]}`;
  const opa = fakeOpa({
    queried: ({ query, input, layers: asked }) => {
      evals.push({ ...input, rule: ruleOf(query) });
      layers.push(Object.values(asked).flatMap(Object.keys).sort());
    },
    answer: (own, input, layer, query) => {
      const rule = ruleOf(query);
      if (failure) return layerOf(failure, layer);
      return evalResult(messages(input, rule, Object.keys(own).sort()));
    },
  });
  const engine = policyEngineOf(t, { opa, operator });
  const policies = createPolicies({
    config: {},
    github: async (repo, method, path) => {
      const listed = path === `/repos/org/repo/contents/.deckhand/policy?ref=${ref}`;
      if (listed && listFails()) return new Response("{}", { status: listFails() });
      if (files && listed) {
        return Response.json(Object.keys(files).map((name) => ({ type: "file", name, sha: name })));
      }
      if (files && path.startsWith("/repos/org/repo/git/blobs/")) {
        const text = files[path.split("/").pop()];
        return Response.json({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
      }
      return new Response("{}", { status: 404 });
    },
    service: localService(engine),
  });
  return { engine: policies, evals, layers };
}
