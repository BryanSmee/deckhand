// What the test files share: servers on a port the OS picks, temp dirs that don't outlive
// their test, a config, a fake GitHub's fetch. `node --test` loads it as a file of its own too
// (everything under test/ matches its patterns), where it finds no test.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../listener/config.mjs";

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
