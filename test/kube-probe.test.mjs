// The network probe's script (kube-probe.mjs PROBE_SCRIPT), run as its pod runs it: `node -e`
// with its targets, against a TCP port that listens, an address that never answers, a UDP
// socket that answers a DNS query and one that never does. test/kubernetes.test.mjs covers what
// the runner makes of its answer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { test } from "node:test";
import { PROBE_SCRIPT } from "../listener/runner/kube-probe.mjs";
import { listening } from "./helpers.mjs";

// A UDP socket on 127.0.0.1 that answers each datagram (`answer`) or not: its port, and the
// datagrams it got.
async function udp(t, answer) {
  const socket = createSocket("udp4");
  const got = [];
  socket.on("message", (message, from) => {
    got.push(message);
    if (answer)
      socket.send(Buffer.from("646881800000000000000000", "hex"), from.port, from.address);
  });
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  t.after(() => socket.close());
  return { port: socket.address().port, got };
}

test("PROBE_SCRIPT: a port that accepts or a DNS server that answers is reached, nothing else", async (t) => {
  const open = createServer((socket) => socket.destroy());
  const openPort = await listening(open);
  t.after(() => open.close());
  // TEST-NET-1 (RFC 5737): no host has it, so nothing ever answers there, whatever else runs.
  // Out of reach by timeout (a blackhole) or at once (unreachable), as the network says.
  const dns = await udp(t, true);
  const silent = await udp(t, false);
  const targets = [
    { host: "127.0.0.1", port: openPort, proto: "tcp" },
    { host: "192.0.2.1", port: 9, proto: "tcp" },
    { host: "127.0.0.1", port: dns.port, proto: "udp" },
    { host: "127.0.0.1", port: silent.port, proto: "udp" },
  ];
  const child = spawn(process.execPath, ["-e", PROBE_SCRIPT, JSON.stringify(targets)]);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), [true, false, true, false]);
  // A DNS query: id, recursion desired, one question, the root's NS records.
  assert.equal(dns.got[0].toString("hex"), "6468010000010000000000000000020001");
});
