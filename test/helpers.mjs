// What the test files share: servers on a port the OS picks, temp dirs that don't outlive
// their test, a config, a fake GitHub's fetch. `node --test` loads it as a file of its own too
// (everything under test/ matches its patterns), where it finds no test.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../listener/config.mjs";
import { createPolicies } from "../listener/policies.mjs";

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

// The policies' engine (policies.mjs) with a fake `opa` and org/repo's policy `files` (name →
// text) on `ref`, the operator's `operator` (likewise): each rule says `messages(input, rule)`, or fails as `failure` says;
// `listFails()`, a status GitHub answers the repo's policy folder with instead (null: none). `evals`:
// the inputs it was asked about, with their `rule`.
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
    run: async (args, { input }) => {
      if (args[0] === "capabilities") return { code: 0, stdout: '{"builtins":[]}' };
      if (args[0] === "check") return { code: 0, stdout: "" };
      const rule = args.at(-1).replace("data.deckhand.", "");
      evals.push({ ...JSON.parse(input), rule });
      if (failure) return failure;
      const value = messages(JSON.parse(input), rule);
      return { code: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value }] }] }) };
    },
    readOperator: () => new Map(Object.entries(operator)),
    tmp: tempDir(t),
  });
  return { engine, evals };
}
