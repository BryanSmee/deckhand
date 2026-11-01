// What the test files share: servers on a port the OS picks, temp dirs that don't outlive
// their test, a config, a fake GitHub's fetch. `node --test` loads it as a file of its own too
// (everything under test/ matches its patterns), where it finds no test.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitBlob } from "../listener/images.mjs";
import { loadConfig } from "../listener/config.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { createRuns, runFields } from "../broker/runs.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { keyFolder, keyId } from "../lib/tokens.mjs";
import { allowOnly, builtInPolicies, createEngine } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import { createPolicyService, ROUTES } from "../policy-service/service.mjs";
import { openLog } from "../listener/runlog.mjs";
import { overlaps } from "../lib/subnets.mjs";

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

// A signing key of the test's own: { privateKey, publicKey, kid }.
export function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, kid: keyId(publicKey) };
}

// The broker service's runs (../broker/runs.mjs) in memory, as the listener's broker
// (broker.mjs) calls them: spread into createBroker()'s options, its `issuer` and `keys`. Also
// `runs`, `store` and `key`, for what the test checks there. `now`: the clock.
export function localBroker({ now = Date.now, key = testKey() } = {}) {
  const store = openStore("memory:", { now });
  const runs = createRuns({ store, key, now });
  const issuer = {
    async issue(id, fields) {
      const issued = await runs.issue(id, fields);
      if (!issued.token) throw new Error(issued.message);
      return issued;
    },
    put: (id, { issued, ...fields }) => runs.put(id, runFields(fields), issued),
    end: (id) => runs.end(id),
  };
  return { issuer, keys: () => new Map([[key.kid, key.publicKey]]), runs, store, key };
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
// server answers as opa's does; `queried({ query, input, layers })` hears each query first. A
// capabilities query (engine.mjs evaluateCapabilities()) gets, for each input, what
// `capabilitiesFor(doc)` names from the operator's layer (Deckhand's mode-*.rego by default) and
// what a repo's unconditional rules name (`allow_capabilities contains "pull"`) from its, each
// as the layer's first file's.
// `calls`: each one, with the staged files; `evals()`: the queries.
export function fakeOpa({
  answer = (files, input) => evalResult([], grantDecision(files, input)),
  queried = () => {},
  checked = () => ({ code: 0, stdout: "" }),
  capabilities = { builtins: [{ name: "count" }] },
  capabilitiesFor = defaultCapabilities,
} = {}) {
  const calls = [];
  // Each staged layer's files (policy/operator/, policy/repo/), name → text as written (the
  // repo's namespaced(): `raw`, as the repo wrote them). Not the capabilities' union, in a folder
  // of its own (byFile()).
  const staged = (cwd, raw) =>
    Object.fromEntries(
      readdirSync(join(cwd, "policy")).map((layer) => [
        layer,
        Object.fromEntries(
          readdirSync(join(cwd, "policy", layer), { withFileTypes: true }).flatMap((entry) => {
            if (!entry.isFile()) return [];
            const n = entry.name;
            const text = readFileSync(join(cwd, "policy", layer, n), "utf8");
            return [[n, raw ? text.replaceAll("deckhand_repository.", "") : text]];
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
        if (query.includes("allow_capabilities")) {
          calls.push({ args: ["eval"], query, input: JSON.stringify(input), cwd: dir, written });
          const asked = [...query.matchAll(/"(operator|repo)": \{"all"/g)].map((m) => m[1]);
          const repo = Object.values(all.repo ?? {}).flatMap((text) =>
            [...text.matchAll(/^allow_capabilities__\d+ contains "([^"]*)"$/gm)].map((m) => m[1]),
          );
          const rules = (names) => ({ allow: [names], deny: [[]] });
          // The first file's, and none of the others' (as many as the query may name).
          const files = (names) => ({
            ...Object.fromEntries(Array.from({ length: 64 }, (_, i) => [i, rules([])])),
            0: rules(names),
          });
          const value = Object.fromEntries(
            Object.entries(input).map(([key, doc]) => [
              key,
              Object.fromEntries(
                asked.map((layer) => {
                  const names = layer === "repo" ? repo : [...capabilitiesFor(doc)];
                  return [layer, { all: rules(names), files: files(names) }];
                }),
              ),
            ]),
          );
          return { status: 200, body: JSON.stringify({ result: [{ result: value }] }) };
        }
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

// The operator's policy file granting `repo` the grants `names` (grants.mjs GRANTS, #498), as an
// operator writes one: what fakeOpa() reads back (grantDecision()), and the real opa evaluates.
export const grantsPolicy = (names, repo = "org/repo") =>
  `package deckhand\n\nallow_grant if {\n  input.repo.name == "${repo}"\n  input.grant in {${names.map((n) => `"${n}"`).join(", ")}}\n}\n`;

// fakeOpa()'s answer to `allow_grant` for a layer's `files`: whether one of them, written as
// grantsPolicy() writes it, gives `input.grant` to `input.repo.name`. Any other decision: allowed.
function grantDecision(files, input) {
  if (input?.decision !== "grant") return true;
  return Object.values(files ?? {}).some((text) =>
    [...text.matchAll(/input\.repo\.name == "([^"]+)"\s*input\.grant in \{([^}]*)\}/g)].some(
      ([, repo, names]) => repo === input.repo?.name && names.includes(`"${input.grant}"`),
    ),
  );
}

// What policies.mjs grants() says of a repository the operator's policies grant `names` (none
// for any other when `repo` is given): grants.mjs grantOf()'s `granted`.
export const grantedOf =
  (names, repo = null) =>
  async (asked) => ({
    granted: new Set(!repo || asked.toLowerCase() === repo ? names : []),
    files: ["grants.rego"],
    denied: [],
  });

// The policy service's engine as the listener sees it through HTTP (policy-client.mjs): each
// request and answer through JSON, so that nothing but what the wire carries gets across.
export function localService(engine) {
  const wire = (value) => JSON.parse(JSON.stringify(value));
  return {
    policies: async () => wire(engine.policies()),
    evaluate: async (body) => wire(await engine.evaluate(wire(body))),
    evaluateCapabilities: async (body) => wire(await engine.evaluateCapabilities(wire(body))),
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

// Policies that allow every GitHub write, read and push (policies.mjs's deny(), as the checks
// call it): for the tests of what the built-in checks refuse before any policy is asked. What
// Deckhand's own allow is the real opa's (defaultPolicies()).
export const allowingPolicies = { deny: async () => [] };

// Deckhand's default policies (policy/*.rego, or `builtIn`: name → text) as the operator's layer,
// evaluated by the real `opa` (hasOpa()), and a repo's own (`repo`, name → text) as GitHub lists
// them on its default branch: createPolicies()'s, stopped after `t`.
export function defaultPolicies(t, { builtIn = builtInPolicies(), repo = {} } = {}) {
  const files = Object.entries(repo);
  const github = async (_repo, _method, url) => {
    const path = url.split("?")[0];
    if (path.endsWith("/contents/.deckhand/policy")) {
      if (!files.length) return new Response("{}", { status: 404 });
      return Response.json(
        files.map(([name], i) => ({ type: "file", name, sha: `sha-${i}`, html_url: null })),
      );
    }
    const blob = /\/git\/blobs\/sha-(\d+)$/.exec(path);
    if (blob) {
      const [, text] = files[Number(blob[1])];
      return Response.json({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
    }
    return new Response("{}", { status: 404 });
  };
  return createPolicies({
    config: {},
    github,
    service: localService(policyEngineOf(t, { opa: opaBinary(), readBuiltIn: () => builtIn })),
  });
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

// The Dockerfile's blob, as the runner's caller reads it and sends it (runner/client.mjs
// imageFor()): `readFile(repo, path, ref)` → { sha } or null.
// A repo's files for a build, as checkout() gives them: its Dockerfile, at the paths the tests
// name, says `seed`, so that its blob, which images.mjs checks against the tag's, is
// contextBlob(seed).
const dockerfileOf = (seed) => `FROM deckhand-sandbox\n# ${seed}\n`;
export const contextBlob = (seed) => gitBlob(Buffer.from(dockerfileOf(seed)));
export function buildContext(t, seed) {
  const dir = tempDir(t, "deckhand-ctx-");
  for (const path of ["Dockerfile", "docker/Dockerfile"]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), dockerfileOf(seed));
  }
  return dir;
}

export function withBlobs(images, readFile) {
  return {
    ...images,
    imageFor: async (asked) =>
      images.imageFor({
        ...asked,
        blob: asked.dockerfile
          ? ((await readFile(asked.repo, asked.dockerfile, asked.ref))?.sha ?? null)
          : null,
      }),
  };
}

// The runner's run logs (runner/client.mjs logs), as files in `dir` (<run>.log): what the
// listener writes a run's log through, and reads it back by.
export function fileLogs(dir) {
  const path = (id) => join(dir, `${id}.log`);
  return {
    open(id) {
      const file = openLog(path(id));
      return {
        write: (text) => file.write(text),
        get size() {
          return file.size;
        },
        ready: Promise.resolve(),
        flushed: async () => true,
      };
    },
    read: async (id, { offset = 0 } = {}) => {
      const data = existsSync(path(id)) ? readFileSync(path(id)).subarray(offset) : Buffer.alloc(0);
      return { size: offset + data.length, data };
    },
    text: async (id) => (existsSync(path(id)) ? readFileSync(path(id), "utf8") : null),
    remove: async (id) => {
      const had = existsSync(path(id));
      rmSync(path(id), { force: true });
      return had;
    },
    upload: async () => {},
  };
}

// A Docker CLI that keeps networks and containers in memory (runner.test.mjs, the runner
// service's tests), for listener/runner/docker.mjs's `docker`: `nets` maps a network to its containers,
// `containers` a container to its run label and state. `answers`: canned answers by
// subcommand (or a function of the arguments giving one, or nothing), over the fake's own.
// `runtimes`: the host's Docker's (`docker info`). `volumes` maps a volume to its labels.
// `subnets` maps a network to its subnet; `taken`: subnets Docker refuses as overlapping
// though no network it lists has them (another project's, created meanwhile).
export function fakeDocker({
  answers = {},
  routeOut = false,
  runtimes = ["runc"],
  taken = [],
} = {}) {
  const nets = new Map();
  const netLabels = new Map();
  const subnets = new Map();
  const internal = new Set();
  const volumes = new Map();
  const containers = new Map([
    // The runner's own (its host name), which says the compose project the proxy is found in.
    [hostname(), { project: "deckhand", ip: "10.0.0.1" }],
    ["egress-id", { project: "deckhand", ip: "10.0.0.3", role: "egress" }],
  ]);
  const ok = (out = "") => ({ code: 0, out, err: "" });
  const missing = { code: 1, out: "", err: "No such object" };
  const networksOf = (name) =>
    Object.fromEntries(
      [...nets]
        .filter(([, on]) => on.has(name))
        .map(([n]) => [n, { IPAddress: containers.get(name).ip }]),
    );
  const docker = async (args) => {
    const key = ["network", "volume"].includes(args[0]) ? `${args[0]} ${args[1]}` : args[0];
    const answer = typeof answers[key] === "function" ? answers[key](args) : answers[key];
    if (answer) return answer;
    const last = args.at(-1);
    switch (key) {
      case "network create":
        if (nets.has(last)) return { code: 1, out: "", err: "already exists" };
        if (args.includes("--subnet")) {
          const subnet = args[args.indexOf("--subnet") + 1];
          if ([...subnets.values(), ...taken].some((s) => overlaps(s, subnet))) {
            return { code: 1, out: "", err: "Pool overlaps with other one on this address space" };
          }
          subnets.set(last, subnet);
        }
        nets.set(last, new Set());
        netLabels.set(
          last,
          Object.fromEntries(
            args.filter((a, i) => args[i - 1] === "--label").map((l) => l.split("=")),
          ),
        );
        if (args.includes("--internal") && !routeOut) internal.add(last);
        return ok();
      case "network inspect":
        if (args.join(" ").includes("IPAM")) {
          return ok(
            args
              .slice(4)
              .filter((n) => nets.has(n))
              .map((n) => (subnets.has(n) ? `${subnets.get(n)} ` : ""))
              .join("\n"),
          );
        }
        if (args.join(" ").includes("IPv4Address")) {
          // Each run network's ID and its containers' addresses (networks.mjs locate()).
          return ok(
            args
              .slice(4)
              .filter((n) => nets.has(n))
              .map((n) => {
                const ips = [...nets.get(n)].map((c) => ` ${c}|${containers.get(c).ip}/24|`);
                return `id-${n}${ips.join("")}`;
              })
              .join("\n"),
          );
        }
        if (!nets.has(last)) return missing;
        if (args[3] === "{{.Id}}") return ok(`id-${last}`);
        if (args[3].includes(".Labels")) {
          const labels = netLabels.get(last) ?? {};
          return ok(`${labels["deckhand.owner"] ?? ""}|${labels["deckhand.run"] ?? ""}`);
        }
        return args.join(" ").includes("Containers")
          ? ok([...nets.get(last)].map((c) => `${c} `).join(""))
          : ok(String(internal.has(last)));
      case "network connect":
        if (!nets.has(args.at(-2))) return missing;
        if (nets.get(args.at(-2)).has(last))
          return { code: 1, out: "", err: "endpoint already exists" };
        nets.get(args.at(-2)).add(last);
        return ok();
      case "network disconnect":
        nets.get(args.at(-2))?.delete(last);
        return ok();
      case "network rm":
        if (nets.get(last)?.size) return { code: 1, out: "", err: "has active endpoints" };
        nets.delete(last);
        subnets.delete(last);
        return ok();
      case "network ls":
        if (args.includes("--quiet")) return ok([...nets.keys()].join("\n"));
        return ok([...nets.keys()].filter((n) => n.startsWith("dh-")).join("\n"));
      case "run": {
        const name = args[args.indexOf("--name") + 1];
        if (containers.has(name)) return { code: 125, out: "", err: "name already in use" };
        const label = (key) => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
        const net = args[args.indexOf("--network") + 1];
        const volume = args.find((a) => a.startsWith("type=volume,src="))?.split(/[=,]/)[3];
        const engine = label("deckhand.engine");
        const ip = engine ? "10.1.0.3" : "10.1.0.2";
        containers.set(name, {
          owner: label("deckhand.owner"),
          run: label("deckhand.run"),
          engine,
          volume,
          running: true,
          ip,
        });
        nets.get(net)?.add(name);
        return ok();
      }
      case "stop":
        if (!containers.has(last)) return missing;
        containers.get(last).running = false;
        return ok();
      case "rm":
        for (const on of nets.values()) on.delete(last);
        containers.delete(last);
        return ok();
      case "info":
        return ok(JSON.stringify(Object.fromEntries(runtimes.map((r) => [r, {}]))));
      case "volume create":
        if (!volumes.has(last)) {
          const labels = args.filter((a, i) => args[i - 1] === "--label");
          volumes.set(last, Object.fromEntries(labels.map((l) => l.split("="))));
        }
        return ok(last);
      case "volume inspect":
        if (!volumes.has(last)) return missing;
        if (args.includes("--format")) {
          const labels = volumes.get(last);
          return ok(`${labels["deckhand.owner"] ?? ""}|${labels["deckhand.engine"] ?? ""}`);
        }
        return ok("[]");
      case "volume rm":
        if ([...containers.values()].some((c) => c.volume === last)) {
          return { code: 1, out: "", err: "volume is in use" };
        }
        return volumes.delete(last) ? ok() : missing;
      case "volume ls":
        return ok(
          [...volumes]
            .filter(([, l]) => l["deckhand.engine"])
            .map(([v, l]) => `${v}\t${l["deckhand.engine"]}`)
            .join("\n"),
        );
      case "ps":
        if (args.join(" ").includes("label=deckhand.engine")) {
          return ok(
            [...containers]
              .filter(([, c]) => c.engine)
              .map(([n, c]) => `${n}\t${c.engine}`)
              .join("\n"),
          );
        }
        if (args.some((a) => a.startsWith("volume="))) {
          const volume = args.find((a) => a.startsWith("volume=")).slice("volume=".length);
          return ok(
            [...containers]
              .filter(([, c]) => c.volume === volume)
              .map(([n]) => n)
              .join("\n"),
          );
        }
        const role = /label=deckhand\.role=(\w+)/.exec(args.join(" "))?.[1];
        if (role) {
          return ok(
            [...containers]
              .filter(([, c]) => c.role === role)
              .map(([n]) => n)
              .join("\n"),
          );
        }
        return ok(
          [...containers]
            .filter(([, c]) => c.run)
            .map(([n, c]) => `${n}\t${c.run}\t${c.running ? "running" : "exited"}`)
            .join("\n"),
        );
      case "inspect": {
        const c = containers.get(last);
        if (!c) return missing;
        const format = args[2];
        if (format.includes("deckhand.owner")) {
          return ok(`${c.owner ?? ""}|${c.run ?? ""}|${c.engine ?? ""}`);
        }
        if (format.includes("compose.project")) return ok(c.project ?? "");
        if (format.includes("deckhand.run")) return ok(c.run ?? "");
        if (format.includes("State")) return ok(c.running ? "running" : "exited");
        return ok(JSON.stringify(networksOf(last)));
      }
      default:
        return ok();
    }
  };
  return { docker, nets, netLabels, subnets, internal, containers, volumes };
}

// What Deckhand's default policies (policy/mode-*.rego) give each mode, as capabilities.test.mjs
// checks with the real opa: a work run (and the operator's ceiling for a repo's own modes) all of
// it, a research run the open internet, the others the code and its reads.
const LIGHT_CAPABILITIES = ["pull", "image:repo", "read:issues", "read:pulls", "read:actions"];
export const WORK_CAPABILITIES = [
  "pull",
  "push",
  "setup",
  "image:repo",
  "image:branch",
  "docker",
  "read:issues",
  "read:pulls",
  "read:actions",
];
export function defaultCapabilities({ mode, custom_mode }) {
  if (mode === "work" || custom_mode) return WORK_CAPABILITIES;
  if (mode === "research") return ["internet"];
  if (mode === "discussion") return [...LIGHT_CAPABILITIES, "read:discussions"];
  return LIGHT_CAPABILITIES;
}

// The policies' capabilityRules() (policies.mjs) without opa: each input gets what
// `operator(input)` names from the operator's layer (file "mode.rego"), and a repo's own mode
// what `repo(input)` names from the repo's ("repo.rego"), none by default. `denies(input)`:
// [{ capability, reason }] of the operator's. `inputs`: what it was asked about. `grants`: the
// names its grants() gives every repository.
export function capabilityPolicies({
  operator = defaultCapabilities,
  repo = () => [],
  denies = () => [],
  grants = [],
} = {}) {
  const inputs = [];
  const layer = (names, file, deny = []) => ({
    allow: new Map(names.map((name) => [name, [file]])),
    deny: deny.map((d) => ({ ...d, file })),
  });
  return {
    inputs,
    // The grants (grants.mjs GRANTS) the operator's policies give the repository: `grants`.
    grants: grantedOf(grants),
    capabilityRules: async (_repo, _ref, asked) => {
      inputs.push(...Object.values(asked));
      return {
        results: Object.fromEntries(
          Object.entries(asked).map(([key, input]) => [
            key,
            {
              operator: layer(operator(input), "mode.rego", denies(input)),
              ...(input.custom_mode && { repo: layer(repo(input), "repo.rego") }),
            },
          ]),
        ),
      };
    },
  };
}
