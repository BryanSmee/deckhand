// The Docker runner, with a fake docker CLI: what it asks Docker, its inbox, and how it
// resumes a sandbox's output where a previous listener stopped.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { aliasOf, CLOSE, createDockerRunner } from "../listener/runner/docker.mjs";

const config = {
  prefix: "dh",
  runsVolume: "dh-runs",
  brokerUrl: "http://listener:8081",
  egressProxy: "http://egress:3128",
  listenerContainer: "me",
  egressContainer: "",
};

// A Docker that keeps networks and containers: `nets` maps a network to its containers,
// `containers` a container to its run label and state. `answers`: canned answers by
// subcommand, over the fake's own.
function fakeDocker({ answers = {}, routeOut = false } = {}) {
  const nets = new Map();
  const internal = new Set();
  const containers = new Map([
    ["me", { project: "deckhand", ip: "10.0.0.1" }],
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
    const key = args[0] === "network" ? `network ${args[1]}` : args[0];
    if (answers[key]) return answers[key];
    const last = args.at(-1);
    switch (key) {
      case "network create":
        if (nets.has(last)) return { code: 1, out: "", err: "already exists" };
        nets.set(last, new Set());
        if (args.includes("--internal") && !routeOut) internal.add(last);
        return ok();
      case "network inspect":
        if (!nets.has(last)) return missing;
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
        return ok();
      case "network ls":
        return ok([...nets.keys()].filter((n) => n.startsWith("dh-")).join("\n"));
      case "run": {
        const name = args[args.indexOf("--name") + 1];
        const run = args.find((a) => a.startsWith("deckhand.run=")).slice("deckhand.run=".length);
        const net = args[args.indexOf("--network") + 1];
        containers.set(name, { run, running: true, ip: "10.1.0.2" });
        nets.get(net)?.add(name);
        return ok();
      }
      case "rm":
        for (const on of nets.values()) on.delete(last);
        containers.delete(last);
        return ok();
      case "ps":
        if (args.join(" ").includes("deckhand.role=egress")) {
          return ok(
            [...containers]
              .filter(([, c]) => c.role === "egress")
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
        if (format.includes("compose.project")) return ok(c.project ?? "");
        if (format.includes("deckhand.run")) return ok(c.run ?? "");
        if (format.includes("State")) return ok(c.running ? "running" : "exited");
        return ok(JSON.stringify(networksOf(last)));
      }
      default:
        return ok();
    }
  };
  return { docker, nets, internal, containers };
}

// `before(args)`: may hold a call back (a promise) before the fake answers it.
function runner({ answers = {}, routeOut, spawn, now, before = () => {} } = {}) {
  const calls = [];
  const fake = fakeDocker({ answers, routeOut });
  const docker = async (args, opts = {}) => {
    calls.push({ args, env: opts.env });
    await before(args);
    return fake.docker(args);
  };
  const inboxDir = mkdtempSync(join(tmpdir(), "deckhand-runs-"));
  const r = createDockerRunner({ config, docker, spawn, inboxDir, now });
  return { r, calls, inboxDir, ...fake };
}

const callOf = (calls, ...words) => calls.find((c) => words.every((w, i) => c.args[i] === w))?.args;

test("start: detached, labelled, secrets by name only, its inbox read-only", async () => {
  const { r, calls, inboxDir } = runner();
  await r.start({
    run: "dh-org-repo-12-1",
    name: "dh-org-repo-12",
    image: "dh-sandbox",
    labels: { "deckhand.task": "org/repo#12" },
    env: { DECKHAND_RUN_SECRET: "s3cret", UNSET: undefined },
  });
  const { args, env } = calls.find((c) => c.args[0] === "run");
  assert.deepEqual(args.slice(0, 4), ["run", "--detach", "--init", "--name"]);
  assert.equal(args.at(-1), "dh-sandbox");
  const joined = args.join(" ");
  assert.match(joined, /--label deckhand\.owner=dh --label deckhand\.run=dh-org-repo-12-1/);
  assert.match(joined, /--label deckhand\.task=org\/repo#12/);
  assert.match(joined, /-e DECKHAND_RUN_SECRET /);
  assert.doesNotMatch(joined, /s3cret|UNSET/);
  assert.equal(env.DECKHAND_RUN_SECRET, "s3cret");
  assert.ok(args.includes("TASK_INBOX=/deckhand/inbox.jsonl"));
  assert.ok(
    args.includes("type=volume,src=dh-runs,dst=/deckhand,volume-subpath=dh-org-repo-12-1,readonly"),
  );
  assert.match(joined, /--network dh-org-repo-12-1 /);
  assert.equal(readFileSync(join(inboxDir, "dh-org-repo-12-1", "inbox.jsonl"), "utf8"), "");
});

test("start: the run's own internal network, with the listener and the proxy on it", async () => {
  const { r, calls, nets } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  assert.deepEqual(callOf(calls, "network", "create"), [
    "network",
    "create",
    "--internal",
    "--label",
    "deckhand.owner=dh",
    "--label",
    "deckhand.run=dh-a-1",
    "dh-a-1",
  ]);
  // Under the names sandboxes call them by; the proxy found by its label.
  assert.ok(calls.some((c) => c.args.join(" ") === "network connect --alias listener dh-a-1 me"));
  assert.ok(
    calls.some((c) => c.args.join(" ") === "network connect --alias egress dh-a-1 egress-id"),
  );
  assert.match(
    callOf(calls, "ps").join(" "),
    /--filter label=deckhand\.role=egress --filter label=com\.docker\.compose\.project=deckhand/,
  );
  // Two sandboxes never share a network.
  assert.deepEqual([...nets.get("dh-a-1")].sort(), ["dh-a", "egress-id", "me"]);
  assert.deepEqual([...nets.get("dh-b-1")].sort(), ["dh-b", "egress-id", "me"]);
});

test("start: a network with a route out stops the run, and goes", async () => {
  const { r, calls, nets } = runner({ routeOut: true });
  await assert.rejects(
    r.start({ run: "dh-a-1", name: "dh-a", image: "i" }),
    /the run's network dh-a-1 is not internal: its sandbox would bypass the egress proxy/,
  );
  assert.equal(callOf(calls, "run"), undefined);
  assert.equal(nets.has("dh-a-1"), false);
});

test("start: a sandbox that doesn't start leaves no network", async () => {
  const { r, nets } = runner({ answers: { run: { code: 125, out: "", err: "no such image" } } });
  await assert.rejects(r.start({ run: "dh-a-1", name: "dh-a", image: "i" }), /no such image/);
  assert.equal(nets.has("dh-a-1"), false);
});

test("start: without the proxy's container, no run", async () => {
  const { r, containers, nets } = runner();
  containers.delete("egress-id");
  await assert.rejects(
    r.start({ run: "dh-a-1", name: "dh-a", image: "i" }),
    /the egress proxy's container wasn't found \(0 labelled deckhand\.role=egress\): set EGRESS_CONTAINER/,
  );
  assert.equal(nets.has("dh-a-1"), false);
});

test("start: a refused run throws with Docker's error", async () => {
  const { r } = runner({ answers: { run: { code: 125, out: "", err: "no such image" } } });
  await assert.rejects(
    r.start({ run: "x-1", name: "x", image: "nope" }),
    /didn't start: no such image/,
  );
});

test("the inbox: messages, then a close line once", async () => {
  const { r, inboxDir } = runner();
  await r.start({ run: "x-1", name: "x", image: "i" });
  assert.equal(r.closed("x-1"), false);
  r.send("x-1", "Also this");
  r.close("x-1");
  r.close("x-1");
  assert.equal(r.closed("x-1"), true);
  const lines = readFileSync(join(inboxDir, "x-1", "inbox.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(JSON.parse(lines[0]), {
    type: "user",
    message: { role: "user", content: "Also this" },
  });
  assert.deepEqual(lines.slice(1), [CLOSE]);
  // No inbox at all: nothing can reach that run.
  assert.equal(r.closed("gone-1"), true);
  await r.remove("x", "x-1");
  assert.equal(existsSync(join(inboxDir, "x-1")), false);
});

test("the image's deckhand-inbox prints the messages until the close line", async () => {
  const { r, inboxDir } = runner();
  await r.start({ run: "x-1", name: "x", image: "i" });
  const script = new URL("../sandbox/deckhand-inbox", import.meta.url).pathname;
  const done = new Promise((resolve, reject) =>
    execFile(script, [join(inboxDir, "x-1", "inbox.jsonl")], { timeout: 10000 }, (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
  r.send("x-1", "one");
  await new Promise((resolve) => setTimeout(resolve, 700)); // a later write is followed too
  r.send("x-1", "two");
  r.close("x-1");
  const out = (await done).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    out.map((m) => m.message.content),
    ["one", "two"],
  );
});

// deckhand-inbox is plain Node in the image and can't import the listener's marker: a copy.
test("deckhand-inbox and the runner agree on the close line", () => {
  const script = readFileSync(new URL("../sandbox/deckhand-inbox", import.meta.url), "utf8");
  const copy = script.match(/^const CLOSE = (.+);$/m);
  assert.ok(copy, "deckhand-inbox declares CLOSE");
  assert.equal(new Function(`return ${copy[1]}`)(), CLOSE);
});

test("list: this deployment's sandboxes, by label", async () => {
  const { r, calls } = runner({
    answers: {
      ps: { code: 0, out: "dh-a\tdh-a-1\trunning\ndh-b\tdh-b-2\texited", err: "" },
    },
  });
  assert.deepEqual(await r.list(), [
    { name: "dh-a", run: "dh-a-1", running: true },
    { name: "dh-b", run: "dh-b-2", running: false },
  ]);
  assert.match(
    calls[0].args.join(" "),
    /--filter label=deckhand\.owner=dh --filter label=deckhand\.run/,
  );
});

test("state and address: null when there is no such sandbox", async () => {
  const { r } = runner();
  assert.equal(await r.state("x"), null);
  assert.equal(await r.address("x"), null);
  const found = runner({
    answers: {
      inspect: {
        code: 0,
        // A sandbox an older listener started is on the shared network: found there too.
        out: '{"deckhand-sandboxes":{"IPAddress":"10.0.0.2","GlobalIPv6Address":"fd00::2"}}',
        err: "",
      },
    },
  });
  assert.deepEqual(await found.r.address("x"), ["10.0.0.2", "fd00::2"]);
});

test("address: the sandbox's own, on its run's network", async () => {
  const { r } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  assert.deepEqual(await r.address("dh-a"), ["10.1.0.2"]);
});

test("remove: the sandbox, then its network, once the listener and the proxy leave it", async () => {
  const { r, nets, containers } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  await r.remove("dh-a", "dh-a-1");
  assert.equal(containers.has("dh-a"), false);
  assert.equal(nets.has("dh-a-1"), false);
  // A leftover, removed by name only: its network is the one its label names.
  await r.remove("dh-b");
  assert.equal(nets.has("dh-b-1"), false);
  // Gone already: nothing to do.
  await r.remove("dh-b");
});

test("relink: a recreated listener and proxy join the running sandboxes' networks again", async () => {
  const { r, calls, nets, containers } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  containers.get("dh-b").running = false; // over, not removed yet: nothing to join
  // `docker compose up -d`: both recreated, on none of those networks.
  for (const on of nets.values()) ["me", "egress-id"].forEach((c) => on.delete(c));
  containers.delete("egress-id");
  containers.set("egress-new", { project: "deckhand", ip: "10.0.0.9", role: "egress" });
  calls.length = 0;
  await r.relink();
  assert.deepEqual([...nets.get("dh-a-1")].sort(), ["dh-a", "egress-new", "me"]);
  assert.deepEqual([...nets.get("dh-b-1")], ["dh-b"]);
  assert.ok(
    calls.some((c) => c.args.join(" ") === "network connect --alias egress dh-a-1 egress-new"),
  );
  // Already joined: nothing more.
  calls.length = 0;
  await r.relink();
  assert.equal(callOf(calls, "network", "connect"), undefined);
});

test("relink: networks whose run is gone are removed, not those of runs starting", async () => {
  const { r, nets } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  // Left by a listener that lost track of its run, and another deployment's.
  nets.set("dh-gone-1", new Set(["me", "egress-id"]));
  nets.set("other-1", new Set());
  // A run whose network exists, its sandbox not yet.
  let go;
  const held = new Promise((resolve) => (go = resolve));
  const slow = runner({ before: (args) => args[0] === "run" && held });
  const starting = slow.r.start({ run: "dh-c-1", name: "dh-c", image: "i" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await slow.r.relink();
  assert.ok(slow.nets.has("dh-c-1"));
  go();
  await starting;
  await r.relink();
  assert.deepEqual([...nets.keys()].sort(), ["dh-a-1", "other-1"]);
});

test("proxyAddresses: the proxy's on all of its networks, looked up again when asked", async () => {
  let clock = 0;
  const { r, calls, containers } = runner({ now: () => clock });
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  containers.get("egress-id").ip = "10.0.0.3";
  assert.deepEqual(await r.proxyAddresses(), ["10.0.0.3", "10.0.0.3"]);
  // Cached...
  containers.get("egress-id").ip = "10.0.0.7";
  calls.length = 0;
  assert.deepEqual(await r.proxyAddresses({ fresh: true }), ["10.0.0.3", "10.0.0.3"]);
  assert.equal(calls.length, 0);
  // ...a caller that isn't among them looks again after a moment, anyone after the TTL.
  clock = 2000;
  assert.deepEqual(await r.proxyAddresses(), ["10.0.0.3", "10.0.0.3"]);
  assert.deepEqual(await r.proxyAddresses({ fresh: true }), ["10.0.0.7", "10.0.0.7"]);
  containers.get("egress-id").ip = "10.0.0.8";
  clock = 12001;
  assert.deepEqual(await r.proxyAddresses(), ["10.0.0.8", "10.0.0.8"]);
});

test("aliasOf: the host name sandboxes use, none for an address", () => {
  assert.equal(aliasOf("http://listener:8081"), "listener");
  assert.equal(aliasOf("http://127.0.0.1:3128"), null);
  assert.equal(aliasOf("http://[::1]:3128"), null);
});

test("follow: whole lines of each stream, skipping what was already read", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let asked;
  const spawn = (cmd, args) => ((asked = [cmd, ...args]), child);
  const { r } = runner({ spawn });
  const out = [];
  const err = [];
  const done = r.follow("x", {
    skip: { out: 2, err: 1 },
    onOut: (line) => out.push(line),
    onErr: (line) => err.push(line),
  });
  child.stdout.write('{"a":1}\n{"a":2}\n{"a"');
  child.stdout.write(':3}\n{"a":4}');
  child.stderr.write("old\nnew\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.deepEqual(asked, ["docker", "logs", "--follow", "x"]);
  // A line cut short isn't read: the next follow() reads it whole.
  assert.deepEqual(out, ['{"a":3}']);
  assert.deepEqual(err, ["new"]);
});
