// What the test files share: servers on a port the OS picks, temp dirs that don't outlive
// their test, a config, a fake GitHub's fetch. `node --test` loads it as a file of its own too
// (everything under test/ matches its patterns), where it finds no test.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../listener/config.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { createRuns } from "../broker/runs.mjs";
import { openStore } from "../lib/store.mjs";
import { keyId } from "../lib/tokens.mjs";

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
    put: (id, fields) => runs.put(id, fields),
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

// The policies' engine (policies.mjs) with a fake `opa` and org/repo's policy `files` (name →
// text) on `ref`, the operator's `operator` (likewise, over Deckhand's allow.rego): each layer
// allows, its deny rule says `messages(input, rule, names)` (names: that layer's files), or it
// fails as `failure` says; `listFails()`, a status GitHub answers the repo's policy folder with
// instead (null: none). `evals`: the inputs it was asked about (one `opa` each), with their
// `rule`; `layers`, each one's file names, both layers'.
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
  const engine = createPolicies({
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
    run: async (args, { input, cwd }) => {
      if (args[0] === "capabilities") return { code: 0, stdout: '{"builtins":[]}' };
      if (args[0] === "check") return { code: 0, stdout: "" };
      // The query asks each staged layer's `allow_<decision>` and `deny_<decision>`: each
      // allows, with `messages` of its files (their names: the operator's or the repo's).
      const rule = `deny_${/\.deny_(\w+)\]/.exec(args.at(-1))[1]}`;
      const staged = readdirSync(join(cwd, "policy"));
      const names = (layer) => readdirSync(join(cwd, "policy", layer)).sort();
      evals.push({ ...JSON.parse(input), rule });
      layers.push(staged.flatMap(names).sort());
      if (failure) return failure;
      const value = Object.fromEntries(
        staged.map((layer) => [
          layer,
          { allow: [true], deny: [messages(JSON.parse(input), rule, names(layer))] },
        ]),
      );
      return { code: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value }] }] }) };
    },
    readOperator: () => new Map(Object.entries(operator)),
    tmp: tempDir(t),
  });
  return { engine, evals, layers };
}
