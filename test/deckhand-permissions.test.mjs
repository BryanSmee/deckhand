// ../sandbox/deckhand-permissions (#479): a chat's agent asks for more permissions, as an MCP
// server over stdio or from a shell, against a fake broker; the run token from a fake
// deckhand-token, never held by the script.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { needsBash, scriptEnv, serve, tempDir } from "./helpers.mjs";

const script = join(import.meta.dirname, "..", "sandbox", "deckhand-permissions");

// A broker answering request "00112233aabbccdd" once asked `polls` times; what it was sent is in
// `calls`.
async function fakeBroker(
  t,
  { status = 202, answer = { state: "granted", message: "Granted." } } = {},
) {
  const calls = [];
  let polls = 0;
  const { url } = await serve(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.method === "POST") {
      const answerBody =
        status === 202
          ? { id: "00112233aabbccdd", state: "pending" }
          : { message: "only a chat's may" };
      return res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(answerBody));
    }
    if (++polls < 2) return res.writeHead(204).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  return { url: `${url}/run/permissions`, calls };
}

// The script's environment: a deckhand-token that prints the run token's header.
function env(t, extra) {
  const bin = tempDir(t);
  writeFileSync(join(bin, "deckhand-token"), "#!/bin/sh\necho 'Bearer run-token'\n", {
    mode: 0o755,
  });
  return scriptEnv(t, { PATH: `${bin}:${process.env.PATH}`, ...extra });
}

function run(t, args, extra) {
  const child = spawn(process.execPath, [script, ...args], { env: env(t, extra) });
  t.after(() => child.kill());
  return child;
}

test(
  "the MCP server: its one tool listed, a call that waits for the broker's answer",
  { skip: needsBash },
  async (t) => {
    const broker = await fakeBroker(t);
    const child = run(t, ["mcp"], { TASK_PERMISSIONS: broker.url });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const call = async (msg) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
      return JSON.parse((await lines.next()).value);
    };
    const init = await call({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "deckhand-permissions");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const { result } = await call({ id: 2, method: "tools/list" });
    assert.deepEqual(
      result.tools.map((tool) => [tool.name, tool.inputSchema.properties.kind.enum]),
      [["request_permission", ["host", "github", "engine", "mount"]]],
    );
    const asked = await call({
      id: 3,
      method: "tools/call",
      params: {
        name: "request_permission",
        arguments: { kind: "host", value: "pypi.org", reason: "pip install" },
      },
    });
    assert.deepEqual(asked, {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "Granted." }] },
    });
    assert.deepEqual(
      broker.calls.map((c) => [c.method, c.url, c.auth]),
      [
        ["POST", "/run/permissions", "Bearer run-token"],
        ["GET", "/run/permissions/00112233aabbccdd", "Bearer run-token"],
        ["GET", "/run/permissions/00112233aabbccdd", "Bearer run-token"],
      ],
    );
    const { key, ...sent } = JSON.parse(broker.calls[0].body);
    // Its key, so that a POST sent again is the same request.
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.deepEqual(sent, {
      kind: "host",
      value: "pypi.org",
      reason: "pip install",
    });
    assert.equal((await call({ id: 4, method: "resources/list" })).error.code, -32601);
  },
);

test(
  "the CLI: the answer printed, exit 0 once granted; a refusal of the broker's is its answer",
  { skip: needsBash },
  async (t) => {
    const exit = (child) => {
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
    };
    const granted = await fakeBroker(t);
    const ok = await exit(
      run(t, ["request", "engine", "docker", "build", "the", "image"], {
        TASK_PERMISSIONS: granted.url,
      }),
    );
    assert.deepEqual(ok, { code: 0, out: "Granted.\n" });
    const { key: _, ...sent } = JSON.parse(granted.calls[0].body);
    assert.deepEqual(sent, {
      kind: "engine",
      value: "",
      reason: "docker build the image",
    });
    const refused = await fakeBroker(t, { status: 403 });
    const no = await exit(
      run(t, ["request", "host", "pypi.org", "pip"], { TASK_PERMISSIONS: refused.url }),
    );
    assert.deepEqual(no, { code: 1, out: "Refused: only a chat's may.\n" });
    // Not a chat: nothing asked.
    const outside = await exit(run(t, ["request", "host", "pypi.org", "pip"], {}));
    assert.equal(outside.code, 1);
    assert.match(outside.out, /not a chat/);
    // A request without its reason: its usage.
    assert.equal((await exit(run(t, ["request", "host", "pypi.org"], {}))).code, 2);
  },
);
