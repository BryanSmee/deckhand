// The network gate (kube-gate.mjs): its script, run as its init container runs it (`node -e`
// with its targets and its deadline), against a TCP port that listens, one that stops listening
// and an address that never answers; and the addresses the runner gives it.
// test/kubernetes.test.mjs and test/kube-images.test.mjs cover what the runner makes of its end.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import {
  CLOSED,
  createNetworkGate,
  failedGate,
  forbiddenTargets,
  GATE_SCRIPT,
  gateProblem,
  gating,
  LEAK,
  MARGIN_MS,
  proxyTarget,
} from "../listener/runner/kube-gate.mjs";
import { closedPort, listening } from "./helpers.mjs";

// TEST-NET-1 (RFC 5737): no host has it, so nothing ever answers there, whatever else runs.
const NOWHERE = { host: "192.0.2.1", port: 9 };

async function open(t) {
  const server = createServer((socket) => socket.destroy());
  const port = await listening(server);
  t.after(() => server.close());
  return { server, port };
}

// The gate run on `targets`, waiting `waitMs` at most (its deadline that long from now):
// { code, out }.
async function gate(targets, waitMs) {
  const until = String(Date.now() + waitMs);
  const child = spawn(process.execPath, ["-e", GATE_SCRIPT, JSON.stringify(targets), until]);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, out: out.trim(), err };
}

// Out of reach as a refused connection: the next test but one waits out one that never answers.
test("GATE_SCRIPT: done once what it mustn't reach is out of reach and the proxy answers", async (t) => {
  const proxy = await open(t);
  const { code, out, err } = await gate(
    [
      { what: "the API server", host: "127.0.0.1", port: await closedPort(), reach: false },
      { what: "the egress proxy", host: "127.0.0.1", port: proxy.port, reach: true },
    ],
    60_000,
  );
  assert.equal(code, 0, err);
  assert.match(out, /^Its NetworkPolicies apply \(\d+ s\)$/);
});

test("GATE_SCRIPT: waits while a target it mustn't reach answers, done once it stops", async (t) => {
  const api = await open(t);
  let tries = 0;
  api.server.on("connection", () => {
    // The policies apply after a few tries: the port stops answering.
    if (++tries === 3) api.server.close();
  });
  const { code, out, err } = await gate(
    [{ what: "the API server", host: "127.0.0.1", port: api.port, reach: false }],
    60_000,
  );
  assert.equal(code, 0, err);
  assert.equal(tries, 3);
  assert.match(out, /Its NetworkPolicies apply/);
});

test("GATE_SCRIPT: past its deadline, LEAK when it still reaches what it mustn't, CLOSED when only the proxy never answered", async (t) => {
  const api = await open(t);
  const leak = await gate(
    [{ what: "the API server", host: "127.0.0.1", port: api.port, reach: false }],
    1000,
  );
  assert.equal(leak.code, LEAK, leak.err);
  assert.match(leak.out, /^still reached the API server \(127\.0\.0\.1:\d+\) after \d+ s$/);

  const closed = await gate([{ what: "the egress proxy", ...NOWHERE, reach: true }], 0);
  assert.equal(closed.code, CLOSED, closed.err);
  assert.match(closed.out, /^never reached the egress proxy \(192\.0\.2\.1:9\) in \d+ s$/);
});

test("forbiddenTargets: the API server's Service and the cluster's DNS, none refused", () => {
  const env = { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "6443" };
  const resolvConf = () => "search svc.cluster.local\nnameserver 10.96.0.10\nnameserver fd00::a\n";
  assert.deepEqual(forbiddenTargets({ env, resolvConf }), [
    { what: "the Kubernetes API server", host: "10.96.0.1", port: 6443 },
    { what: "the cluster's DNS", host: "10.96.0.10", port: 53 },
    { what: "the cluster's DNS", host: "fd00::a", port: 53 },
  ]);
  // Nothing to wait on proves nothing: fail closed.
  const none = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.throws(() => forbiddenTargets({ env: {}, resolvConf: none }), /knows no address/);
  // The gate's container, from the base image, small, giving up MARGIN_MS before
  // KUBERNETES_PENDING_MINUTES from now, or before its caller's own limit.
  const config = { image: "dh-sandbox", kubernetes: { pendingMs: 600_000 } };
  const now = () => 1_000_000;
  const gates = createNetworkGate({ config, env, resolvConf, now });
  const container = gates.container({ proxy: { host: "10.96.0.11", port: 3128 } });
  assert.equal(container.name, "network-gate");
  assert.equal(container.image, "dh-sandbox");
  assert.deepEqual(container.command.slice(0, 2), ["node", "-e"]);
  assert.equal(container.command[4], String(1_000_000 + 600_000 - MARGIN_MS));
  assert.equal(gates.container({ withinMs: 300_000 }).command[4], String(1_000_000 + 270_000));
  // A limit shorter than the margin: one round, then its verdict.
  assert.equal(gates.container({ withinMs: 10_000 }).command[4], "1000000");
  assert.deepEqual(JSON.parse(container.command[3]).at(-1), {
    what: "the egress proxy",
    host: "10.96.0.11",
    port: 3128,
    reach: true,
  });
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.throws(
    () => createNetworkGate({ config, env: {}, resolvConf: none }).container(),
    /knows no address/,
  );
});

test("proxyTarget, failedGate, gating, gateProblem", () => {
  const config = { egressProxy: "http://egress:3128" };
  assert.deepEqual(proxyTarget(config, { ip: "10.96.0.11" }), { host: "10.96.0.11", port: 3128 });
  assert.deepEqual(proxyTarget({ egressProxy: "http://[fd00::1]:8080" }, null), {
    host: "fd00::1",
    port: 8080,
  });
  const pod = (state) => ({
    status: { initContainerStatuses: [{ name: "network-gate", state }] },
  });
  assert.equal(failedGate(pod({ terminated: { exitCode: 3 } })), 3);
  assert.equal(failedGate(pod({ terminated: { exitCode: 0 } })), null);
  assert.equal(failedGate({ status: {} }), null);
  assert.equal(gating(pod({ running: {} })), true);
  assert.equal(gating(pod({ terminated: { exitCode: 0 } })), false);
  assert.equal(
    gateProblem(LEAK, "still reached x"),
    "its NetworkPolicies didn't apply: still reached x",
  );
  assert.match(gateProblem(CLOSED, "never reached y"), /reach the egress proxy/);
  assert.equal(gateProblem(137, ""), "its init container network-gate failed (exit 137)");
});
