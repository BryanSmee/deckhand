// The Docker runner, with a fake docker CLI: what it asks Docker, its inbox, and how it
// resumes a sandbox's output where a previous listener stopped.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  aliasOf,
  CLOSE,
  createDockerRunner,
  LINE_CUT,
  MAX_LINE,
} from "../listener/runner/docker.mjs";
import { MAX_READ } from "../listener/runner/inbox.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { overlaps, parseCidr } from "../listener/subnets.mjs";
import { tempDir } from "./helpers.mjs";

const SPEC = { user: SANDBOX_USER, limits: { cpus: "1", memory: "1g", pids: 256 } };

const config = {
  prefix: "dh",
  brokerUrl: "http://listener:8081",
  egressProxy: "http://egress:3128",
  listenerContainer: "me",
  egressContainer: "",
  engine: "auto",
  engineImage: "dh-engine",
  enginePodmanImage: "dh-engine-podman",
};

// A Docker that keeps networks and containers: `nets` maps a network to its containers,
// `containers` a container to its run label and state. `answers`: canned answers by
// subcommand (or a function of the arguments giving one, or nothing), over the fake's own.
// `runtimes`: the host's Docker's (`docker info`). `volumes` maps a volume to its labels.
// `subnets` maps a network to its subnet; `taken`: subnets Docker refuses as overlapping
// though no network it lists has them (another project's, created meanwhile).
function fakeDocker({ answers = {}, routeOut = false, runtimes = ["runc"], taken = [] } = {}) {
  const nets = new Map();
  const subnets = new Map();
  const internal = new Set();
  const volumes = new Map();
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
          // Each run network's ID and its containers' addresses (networks.mjs sandboxOf()).
          return ok(
            args
              .slice(4)
              .filter((n) => nets.has(n))
              .map((n) => {
                const ips = [...nets.get(n)].map((c) => ` ${containers.get(c).ip}/24 `);
                return `id-${n}${ips.join("")}`;
              })
              .join("\n"),
          );
        }
        if (!nets.has(last)) return missing;
        if (args[3] === "{{.Id}}") return ok(`id-${last}`);
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
        containers.set(name, { run: label("deckhand.run"), engine, volume, running: true, ip });
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
        return volumes.has(last) ? ok("[]") : missing;
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
  return { docker, nets, subnets, internal, containers, volumes };
}

// `before(args)`: may hold a call back (a promise) before the fake answers it.
function runner({
  answers = {},
  routeOut,
  runtimes,
  taken,
  subnets,
  spawn,
  now,
  before = () => {},
  engine = config.engine,
} = {}) {
  const calls = [];
  const fake = fakeDocker({ answers, routeOut, runtimes, taken });
  const docker = async (args, opts = {}) => {
    calls.push({ args, env: opts.env });
    await before(args);
    return fake.docker(args);
  };
  const inboxDir = tempDir(null, "deckhand-runs-");
  const runner = createDockerRunner({
    config: { ...config, engine, subnets: subnets ?? null },
    docker,
    spawn,
    inboxDir,
    now,
  });
  // A sandbox spec always has its user and limits (sandbox-spec.mjs): these tests give the rest.
  const r = { ...runner, start: (spec) => runner.start({ ...SPEC, ...spec }) };
  return { r, calls, inboxDir, ...fake };
}

const callOf = (calls, ...words) => calls.find((c) => words.every((w, i) => c.args[i] === w))?.args;

test("start: detached, labelled, secrets by name only, its inbox at the broker", async () => {
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
  assert.ok(args.includes("TASK_INBOX=http://listener:8081/run/inbox"));
  // Nothing of the listener's is mounted: the run's files go through the broker (#393).
  assert.doesNotMatch(joined, /--mount|-v /);
  assert.match(joined, /--network dh-org-repo-12-1 /);
  assert.equal(readFileSync(join(inboxDir, "dh-org-repo-12-1", "inbox.jsonl"), "utf8"), "");
});

test("start: the run's tokens bound to its network's ID, by name only; sandboxOf() finds it", async () => {
  let now = 0;
  const { r, calls } = runner({ now: () => now });
  const bound = [];
  await r.start({
    run: "dh-org-repo-12-1",
    name: "dh-org-repo-12",
    image: "dh-sandbox",
    env: { TASK_PROMPT: "p" },
    tokens: async (sandbox) => (bound.push(sandbox), { DECKHAND_RUN_TOKEN: `t@${sandbox}` }),
  });
  assert.deepEqual(bound, ["id-dh-org-repo-12-1"]);
  const { args, env } = calls.find((c) => c.args[0] === "run");
  assert.ok(args.includes("DECKHAND_RUN_TOKEN"));
  assert.doesNotMatch(args.join(" "), /t@/);
  assert.equal(env.DECKHAND_RUN_TOKEN, "t@id-dh-org-repo-12-1");
  // The sandbox's address on it, and the listener's and the proxy's: that network's ID.
  assert.equal(await r.sandboxOf("10.1.0.2"), "id-dh-org-repo-12-1");
  assert.equal(await r.sandboxOf("10.9.9.9"), null);
  // Looked up once, until a miss lets it look again, at most every 2 seconds.
  const looks = () => calls.filter((c) => c.args.join(" ").includes("IPv4Address")).length;
  assert.equal(await r.sandboxOf("10.1.0.2"), "id-dh-org-repo-12-1");
  assert.equal(looks(), 1);
  // Gone with its network: an address never names a network that was removed.
  await r.remove("dh-org-repo-12", "dh-org-repo-12-1");
  assert.equal(await r.sandboxOf("10.1.0.2"), null);
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

// SANDBOX_SUBNETS, as config.mjs gives it.
const range = (cidr, size = 28) => ({ range: cidr, ...parseCidr(cidr), size });

test("start: with SANDBOX_SUBNETS, each run's network on its own block of the range", async () => {
  const { r, calls, subnets } = runner({ subnets: range("10.200.0.0/16") });
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  assert.deepEqual(callOf(calls, "network", "create").slice(-3), [
    "--subnet",
    "10.200.0.0/28",
    "dh-a-1",
  ]);
  assert.ok(callOf(calls, "network", "create").includes("--internal"));
  assert.equal(subnets.get("dh-b-1"), "10.200.0.16/28");
  // A block freed by a run that ended is used again.
  await r.remove("dh-a", "dh-a-1");
  await r.start({ run: "dh-c-1", name: "dh-c", image: "i" });
  assert.equal(subnets.get("dh-c-1"), "10.200.0.0/28");
});

test("start: blocks any network on the host uses are skipped", async () => {
  const { r, nets, subnets } = runner({ subnets: range("10.200.0.0/24", 28) });
  // Another project's /27 covers the first two blocks.
  nets.set("other", new Set());
  subnets.set("other", "10.200.0.0/27");
  nets.set("host", new Set()); // no subnet
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  assert.equal(subnets.get("dh-a-1"), "10.200.0.32/28");
});

test("start: a block Docker says overlaps moves on to the next one, a few times", async () => {
  const { r, subnets } = runner({
    subnets: range("10.200.0.0/24"),
    taken: ["10.200.0.0/28", "10.200.0.16/28"],
  });
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  assert.equal(subnets.get("dh-a-1"), "10.200.0.32/28");
  // Not forever: past a few overlaps, Docker's error.
  const crowded = runner({ subnets: range("10.200.0.0/16"), taken: ["10.200.0.0/24"] });
  await assert.rejects(
    crowded.r.start({ run: "dh-a-1", name: "dh-a", image: "i" }),
    /the run's network dh-a-1 wasn't created: Pool overlaps/,
  );
  assert.equal(crowded.calls.filter((c) => c.args[1] === "create").length, 5);
  assert.equal(callOf(crowded.calls, "run"), undefined);
});

test("start: a full SANDBOX_SUBNETS says so, and what to change", async () => {
  const { r, calls, nets, subnets } = runner({ subnets: range("10.200.0.0/27", 28) });
  nets.set("other", new Set());
  subnets.set("other", "10.200.0.0/28");
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await assert.rejects(
    r.start({ run: "dh-b-1", name: "dh-b", image: "i" }),
    /no free block of \/28 left in SANDBOX_SUBNETS \(10\.200\.0\.0\/27\)\. Set a larger range or a lower MAX_PARALLEL/,
  );
  assert.equal(nets.has("dh-b-1"), false);
  assert.equal(calls.filter((c) => c.args[1] === "create").length, 1);
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

test("start: a spec without its user or limits starts nothing, not even its network", async () => {
  const { r, calls, nets } = runner();
  for (const missing of [{ user: undefined }, { limits: undefined }]) {
    await assert.rejects(
      r.start({ run: "dh-a-1", name: "dh-a", image: "i", ...missing }),
      /the sandbox spec has no (user|limits)/,
    );
  }
  assert.equal(nets.has("dh-a-1"), false);
  assert.ok(!calls.some((c) => ["run", "network"].includes(c.args[0])));
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
  let printed;
  const first = new Promise((resolve) => (printed = resolve));
  const done = new Promise((resolve, reject) => {
    const child = execFile(
      script,
      [join(inboxDir, "x-1", "inbox.jsonl")],
      { timeout: 10000 },
      (e, out) => (e ? reject(e) : resolve(out)),
    );
    child.stdout.once("data", printed);
  });
  r.send("x-1", "one");
  // A write after the script read the file to its end is followed too.
  await first;
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

// A clock of the test's own for poll()'s wait: the timers it set, fired by hand.
function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimeout: (fn) => (pending.add(fn), fn),
    clearTimeout: (fn) => pending.delete(fn),
    fire: () => [...pending].forEach((fn) => (pending.delete(fn), fn())),
  };
}

test("poll: the whole lines after an offset, waiting for the next one, or none at the timeout", async () => {
  const timers = fakeTimers();
  const inboxDir = tempDir(null, "deckhand-runs-");
  const r = createDockerRunner({ config, docker: fakeDocker().docker, inboxDir, timers });
  await r.start({ ...SPEC, run: "x-1", name: "x", image: "i" });
  assert.equal(await r.poll("gone-1", 0), null);
  r.send("x-1", "one");
  const first = await r.poll("x-1", 0);
  assert.equal(JSON.parse(first).message.content, "one");
  // Nothing after it yet: waits, until a message comes.
  const waiting = r.poll("x-1", first.length);
  assert.equal(timers.pending.size, 1);
  r.send("x-1", "two");
  const second = await waiting;
  assert.equal(JSON.parse(second).message.content, "two");
  assert.equal(timers.pending.size, 0, "its timer cleared");
  // Nothing comes: an empty answer at the timeout.
  const quiet = r.poll("x-1", first.length + second.length);
  timers.fire();
  assert.equal((await quiet).length, 0);
  // A request that goes away stops waiting.
  const gone = new AbortController();
  const aborted = r.poll("x-1", first.length + second.length, { signal: gone.signal });
  gone.abort();
  assert.equal((await aborted).length, 0);
  // A restarted listener (another runner, the same folder) answers from the same offset:
  // nothing lost, nothing repeated.
  r.close("x-1");
  const again = createDockerRunner({ config, docker: fakeDocker().docker, inboxDir, timers });
  assert.equal((await again.poll("x-1", first.length + second.length)).toString(), CLOSE + "\n");
  assert.equal((await again.poll("x-1", 0)).toString(), `${first}${second}${CLOSE}\n`);
});

test("poll: a line not yet whole isn't answered, one over MAX_READ comes alone", async () => {
  const inboxDir = tempDir(null, "deckhand-runs-");
  const r = createDockerRunner({ config, docker: fakeDocker().docker, inboxDir });
  await r.start({ ...SPEC, run: "x-1", name: "x", image: "i" });
  const file = join(inboxDir, "x-1", "inbox.jsonl");
  appendFileSync(file, '{"half":');
  const gone = new AbortController();
  const half = r.poll("x-1", 0, { signal: gone.signal });
  gone.abort();
  assert.equal((await half).length, 0);
  appendFileSync(file, `"${"x".repeat(MAX_READ)}"}\nshort\n`);
  const big = await r.poll("x-1", 0);
  assert.equal(big.toString().split("\n").length, 2, "one line");
  assert.equal((await r.poll("x-1", big.length)).toString(), "short\n");
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
      // A sandbox an older listener started is on the shared network: found there too.
      inspect: (args) =>
        args.at(-1) === "x" && {
          code: 0,
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
  assert.equal(await r.engineAddress("dh-a"), null);
});

test("start with the egress proxy's CA: in the inbox folder, at the broker as DECKHAND_CA", async () => {
  const { r, calls, inboxDir } = runner();
  const pem = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n";
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i", ca: pem });
  assert.equal(readFileSync(join(inboxDir, "dh-a-1", "egress-ca.crt"), "utf8"), pem);
  const { args } = calls.find((c) => c.args[0] === "run");
  assert.match(args.join(" "), /-e DECKHAND_CA=http:\/\/listener:8081\/run\/ca /);
  assert.equal(r.file("dh-a-1", "ca").toString(), pem);
  // None without it.
  const other = runner();
  await other.r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  const run = other.calls.find((c) => c.args[0] === "run").args.join(" ");
  assert.doesNotMatch(run, /DECKHAND_CA/);
  assert.equal(other.r.file("dh-b-1", "ca"), null);
  assert.equal(existsSync(join(other.inboxDir, "dh-b-1", "egress-ca.crt")), false);
});

test("start with a run digest: in the inbox folder, at the broker as TASK_DIGEST", async () => {
  const { r, calls, inboxDir } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i", digest: "# Run digest\n" });
  assert.equal(readFileSync(join(inboxDir, "dh-a-1", "digest.md"), "utf8"), "# Run digest\n");
  const { args } = calls.find((c) => c.args[0] === "run");
  assert.match(args.join(" "), /-e TASK_DIGEST=http:\/\/listener:8081\/run\/digest /);
  assert.equal(r.file("dh-a-1", "digest").toString(), "# Run digest\n");
  // Only the run's own files, by name.
  assert.equal(r.file("dh-a-1", "inbox"), null);
  assert.equal(r.file("dh-a-1", "../dh-a-1/digest.md"), null);
  const other = runner();
  await other.r.start({ run: "dh-b-1", name: "dh-b", image: "i" });
  assert.doesNotMatch(other.calls.find((c) => c.args[0] === "run").args.join(" "), /TASK_DIGEST/);
  assert.equal(existsSync(join(other.inboxDir, "dh-b-1", "digest.md")), false);
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

test("kill: stops the sandbox now, SIGKILL after 10 s; one that isn't there is an error", async () => {
  const { r, calls, containers } = runner();
  await r.start({ run: "dh-a-1", name: "dh-a", image: "i" });
  await r.kill("dh-a");
  assert.deepEqual(callOf(calls, "stop"), ["stop", "-t", "10", "dh-a"]);
  assert.equal(containers.get("dh-a").running, false);
  // Stopped, not removed: finish() reads its end, then removes it.
  assert.equal(await r.state("dh-a"), "exited");
  await assert.rejects(r.kill("dh-gone"), /docker stop dh-gone/);
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
  assert.deepEqual(asked, ["docker", "logs", "--follow", "--timestamps", "x"]);
  // A line cut short isn't read: the next follow() reads it whole.
  assert.deepEqual(out, ['{"a":3}']);
  assert.deepEqual(err, ["new"]);
});

// #414: Docker's time for each line, without its stamp, for lines read again after a restart
// too (skipped ones count as before).
test("follow: each line with when Docker says it was written", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const { r } = runner({ spawn: () => child });
  const out = [];
  const err = [];
  const done = r.follow("x", {
    skip: { out: 1, err: 0 },
    onOut: (line, at) => out.push([line, at]),
    onErr: (line, at) => err.push([line, at]),
  });
  child.stdout.write("2026-10-29T08:00:00.000000000Z old\n2026-10-29T08:00:12.345678901Z ");
  child.stdout.write('{"a":1}\n2026-10-29T10:00:01+02:00 {"a":2}\nno stamp\n');
  child.stderr.write("2026-10-29T08:00:00.5Z Cloning\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.deepEqual(out, [
    ['{"a":1}', Date.parse("2026-10-29T08:00:12.345Z")],
    ['{"a":2}', Date.parse("2026-10-29T08:00:01Z")],
    ["no stamp", null],
  ]);
  assert.deepEqual(err, [["Cloning", Date.parse("2026-10-29T08:00:00.500Z")]]);
});

// Docker keeps a line over 16 KiB in parts of 16384 bytes, and --timestamps stamps each one,
// inside the line (moby/moby#37681): stamps at those bytes go, even inside a character.
test("follow: the stamps Docker writes inside a line over 16 KiB go", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const { r } = runner({ spawn: () => child });
  const out = [];
  const done = r.follow("x", { onOut: (line, at) => out.push([line, at]), onErr: () => {} });
  // A "✓" (3 bytes) across the first part's end, the second stamp shorter (no nanoseconds).
  const line = Buffer.from(`{"a":"${"x".repeat(16384 - 7)}✓${"y".repeat(20000)}"}`);
  const stamps = [
    "2026-10-29T08:00:12.345678901Z ",
    "2026-10-29T08:00:12.4Z ",
    "2026-10-29T08:00:13Z ",
  ];
  const parts = [];
  for (let i = 0; i * 16384 < line.length; i++)
    parts.push(Buffer.from(stamps[i]), line.subarray(i * 16384, (i + 1) * 16384));
  const all = Buffer.concat([...parts, Buffer.from("\n2026-10-29T08:00:14Z next\n")]);
  // In odd chunks, as a pipe gives them.
  for (let i = 0; i < all.length; i += 1000) child.stdout.write(all.subarray(i, i + 1000));
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.equal(out.length, 2);
  assert.equal(out[0][0], line.toString("utf8"));
  assert.deepEqual(JSON.parse(out[0][0]).a.length, 16384 - 7 + 1 + 20000);
  assert.equal(out[0][1], Date.parse("2026-10-29T08:00:12.345Z"));
  assert.deepEqual(out[1], ["next", Date.parse("2026-10-29T08:00:14Z")]);
});

// As Docker 28 writes it: the bytes of a character split between two parts are U+FFFDs, so the
// first part is 16386 bytes, and the inner stamp comes 2 bytes later.
test("follow: an inner stamp after a part that U+FFFDs made longer goes too", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const { r } = runner({ spawn: () => child });
  const out = [];
  const done = r.follow("x", { onOut: (line) => out.push(line), onErr: () => {} });
  const stamp = "2026-10-29T16:50:21.752745188Z ";
  const first = `${"x".repeat(16383)}\uFFFD`;
  const second = `\uFFFD\uFFFD${"✓".repeat(100)}`;
  assert.equal(Buffer.byteLength(first), 16386);
  child.stdout.write(`${stamp}${first}${stamp}${second}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.deepEqual(out, [first + second]);
});

test("follow: a stamped line over MAX_LINE is cut at MAX_LINE of its own", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const { r } = runner({ spawn: () => child });
  const out = [];
  const done = r.follow("x", { onOut: (line, at) => out.push([line, at]), onErr: () => {} });
  child.stdout.write("2026-10-29T08:00:00.000000000Z " + "x".repeat(MAX_LINE + 10) + "\nnext\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.deepEqual(out, [
    ["x".repeat(MAX_LINE) + LINE_CUT, Date.parse("2026-10-29T08:00:00Z")],
    ["next", null],
  ]);
});

// #241: unbounded, a line with no newline grew until its string couldn't, and the stream's
// handler threw the listener down.
test("follow: a line over MAX_LINE is cut there, its rest dropped up to its newline", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const { r } = runner({ spawn: () => child });
  const err = [];
  const done = r.follow("x", { onOut: () => {}, onErr: (line) => err.push(line) });
  // 2 MB in 64 KB chunks, as a pipe gives them, then the next line.
  const chunk = "x".repeat(64 * 1024);
  for (let i = 0; i < 32; i++) child.stderr.write(chunk);
  child.stderr.write("y\nnext\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.equal(err.length, 2);
  assert.equal(err[0], "x".repeat(MAX_LINE) + LINE_CUT);
  assert.equal(err[1], "next");
});

test("follow: a handler that throws loses its line, not the listener", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const logs = [];
  const r = createDockerRunner({
    config,
    docker: async () => ({ code: 0, out: "" }),
    spawn: () => child,
    inboxDir: tempDir(null, "deckhand-runs-"),
    log: (line) => logs.push(line),
  });
  const out = [];
  const done = r.follow("x", {
    onOut: (line) => {
      if (line === "bad") throw new Error("ENOSPC: no space left on device");
      out.push(line);
    },
    onErr: () => {},
  });
  child.stdout.write("bad\ngood\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 0);
  await done;
  assert.deepEqual(out, ["good"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^docker logs x: Error: ENOSPC: no space left on device\n    at /);
});

// --- The container engine (engine.mjs) -------------------------------------------------

const limits = { cpus: "2", memory: "4g", pids: 2048 };
const withEngine = (engine = {}) => ({
  run: "dh-a-1",
  name: "dh-a",
  image: "i",
  labels: { "deckhand.task": "org/repo#1" },
  engine: { limits, cache: null, ...engine },
});

test("start: no engine asked for, none started and no DOCKER_HOST", async () => {
  const { r, calls, containers } = runner();
  assert.deepEqual(await r.start({ run: "dh-a-1", name: "dh-a", image: "i" }), { engine: null });
  assert.equal(containers.has("dh-a-engine"), false);
  assert.ok(!calls.some((c) => c.args[0] === "info" || c.args[0] === "volume"));
  assert.doesNotMatch(callOf(calls, "run").join(" "), /DOCKER_HOST/);
});

test("start: the engine first, on the run's network as `engine`, then the sandbox pointed at it", async () => {
  const { r, calls, nets, containers, volumes } = runner({ runtimes: ["runc", "sysbox-runc"] });
  const started = await r.start(withEngine());
  assert.deepEqual(started, {
    engine: { backend: "sysbox", volume: "dh-a-1-engine", cached: false },
  });
  const runs = calls.filter((c) => c.args[0] === "run").map((c) => c.args);
  assert.equal(runs.length, 2);
  const [engine, sandbox] = runs;
  const joined = engine.join(" ");
  assert.match(joined, /--name dh-a-engine /);
  assert.match(joined, /--network dh-a-1 --network-alias engine /);
  assert.match(joined, /--runtime sysbox-runc /);
  assert.match(joined, /--cpus 2 --memory 4g --memory-swap 4g --pids-limit 2048 /);
  assert.match(joined, /type=volume,src=dh-a-1-engine,dst=\/var\/lib\/docker/);
  assert.match(joined, /-e EGRESS_PROXY=http:\/\/egress:3128 /);
  assert.equal(engine.at(-1), "dh-engine");
  // Labelled as the run's engine, never as a sandbox: list() doesn't see it.
  assert.match(joined, /--label deckhand\.engine=dh-a-1 --label deckhand\.task=org\/repo#1/);
  assert.doesNotMatch(joined, /deckhand\.run=/);
  assert.deepEqual(await r.list(), [{ name: "dh-a", run: "dh-a-1", running: true }]);
  // Never privileged, never the host's socket.
  assert.doesNotMatch(joined, /--privileged|docker\.sock/);
  assert.match(sandbox.join(" "), /-e DOCKER_HOST=tcp:\/\/engine:2375 /);
  assert.doesNotMatch(sandbox.join(" "), /DOCKER_BUILDKIT/);
  assert.deepEqual([...nets.get("dh-a-1")].sort(), ["dh-a", "dh-a-engine", "egress-id", "me"]);
  assert.deepEqual(volumes.get("dh-a-1-engine"), {
    "deckhand.owner": "dh",
    "deckhand.engine": "dh-a-1",
  });
  assert.equal(containers.get("dh-a-engine").volume, "dh-a-1-engine");
  // The sandbox's and the engine's, each from its own inspection: the broker counts both as the
  // run's, and tells the engine apart (broker-http.mjs hasAddress()).
  assert.deepEqual(await r.address("dh-a"), ["10.1.0.2"]);
  assert.deepEqual(await r.engineAddress("dh-a"), ["10.1.0.3"]);
});

test("start: auto without Sysbox is Podman, with what it relaxes and no BuildKit", async () => {
  const { r, calls } = runner();
  const { engine } = await r.start(withEngine());
  assert.equal(engine.backend, "podman");
  const [run, sandbox] = calls.filter((c) => c.args[0] === "run").map((c) => c.args.join(" "));
  assert.match(run, /--security-opt seccomp=unconfined --security-opt apparmor=unconfined /);
  assert.match(run, /--device \/dev\/fuse --device \/dev\/net\/tun /);
  assert.match(run, /dst=\/home\/podman\/\.local\/share\/containers dh-engine-podman$/);
  assert.doesNotMatch(run, /--privileged|docker\.sock|sysbox/);
  assert.match(sandbox, /-e DOCKER_HOST=tcp:\/\/engine:2375 -e DOCKER_BUILDKIT=0 /);
});

test("start: SANDBOX_ENGINE=sysbox without its runtime starts nothing and leaves nothing", async () => {
  const { r, calls, nets, containers, volumes } = runner({ engine: "sysbox" });
  await assert.rejects(r.start(withEngine()), /no sysbox-runc runtime/);
  assert.equal(calls.filter((c) => c.args[0] === "run").length, 0);
  assert.equal(nets.has("dh-a-1"), false);
  assert.equal(containers.has("dh-a-engine"), false);
  assert.equal(volumes.size, 0);
  // Podman asks Docker nothing about runtimes.
  const podman = runner({ engine: "podman" });
  await podman.r.start(withEngine());
  assert.ok(!podman.calls.some((c) => c.args[0] === "info"));
});

test("start: a sandbox that doesn't start takes its engine and volume with it", async () => {
  const { r, nets, containers, volumes } = runner({
    answers: {
      run: (args) => args.includes("dh-a") && { code: 125, out: "", err: "no such image" },
    },
  });
  await assert.rejects(r.start(withEngine()), /no such image/);
  assert.equal(containers.has("dh-a-engine"), false);
  assert.equal(volumes.size, 0);
  assert.equal(nets.has("dh-a-1"), false);
});

test("start: an engine that doesn't start stops the run", async () => {
  const { r, calls } = runner({
    answers: {
      run: (args) => args.includes("dh-a-engine") && { code: 125, out: "", err: "no such image" },
    },
  });
  await assert.rejects(r.start(withEngine()), /its container engine didn't start: no such image/);
  assert.equal(calls.filter((c) => c.args[0] === "run").length, 1);
});

test("start: the repo's cache volume when free, fresh storage while another run has it", async () => {
  const { r, volumes } = runner();
  const cache = "dh-engine-cache-org-repo-abc";
  const first = await r.start(withEngine({ cache }));
  assert.deepEqual(first.engine, {
    backend: "podman",
    volume: `${cache}-podman`,
    cached: true,
  });
  // Kept, and not swept: it has no run.
  assert.deepEqual(volumes.get(`${cache}-podman`), { "deckhand.owner": "dh" });
  const second = await r.start({ ...withEngine({ cache }), run: "dh-b-1", name: "dh-b" });
  assert.deepEqual(second.engine, { backend: "podman", volume: "dh-b-1-engine", cached: false });
  await r.remove("dh-a", "dh-a-1");
  assert.ok(volumes.has(`${cache}-podman`));
  const third = await r.start({ ...withEngine({ cache }), run: "dh-c-1", name: "dh-c" });
  assert.equal(third.engine.cached, true);
});

test("start: a cache volume a container still holds (a previous listener's) isn't shared", async () => {
  const { r, containers } = runner();
  const cache = "dh-engine-cache-org-repo-abc";
  containers.set("dh-z-engine", { engine: "dh-z-1", volume: `${cache}-podman`, running: true });
  const { engine } = await r.start(withEngine({ cache }));
  assert.equal(engine.cached, false);
});

test("remove: the sandbox, its engine and the run's volume, then its network", async () => {
  const { r, nets, containers, volumes } = runner();
  await r.start(withEngine());
  await r.remove("dh-a", "dh-a-1");
  assert.equal(containers.has("dh-a"), false);
  assert.equal(containers.has("dh-a-engine"), false);
  assert.equal(volumes.has("dh-a-1-engine"), false);
  assert.equal(nets.has("dh-a-1"), false);
  // A leftover sandbox (no run given): its run is the one its label names.
  await r.start(withEngine());
  await r.remove("dh-a");
  assert.equal(containers.has("dh-a-engine"), false);
  assert.equal(volumes.has("dh-a-1-engine"), false);
});

test("relink: engines and volumes whose run is gone are removed, not those of live runs", async () => {
  const { r, containers, volumes, calls } = runner();
  await r.start(withEngine());
  // A listener that stopped mid-removal: the sandbox went, its engine and volume didn't.
  containers.set("dh-z-engine", { engine: "dh-z-1", volume: "dh-z-1-engine", running: true });
  volumes.set("dh-z-1-engine", { "deckhand.owner": "dh", "deckhand.engine": "dh-z-1" });
  volumes.set("dh-y-1-engine", { "deckhand.owner": "dh", "deckhand.engine": "dh-y-1" });
  await r.relink();
  assert.equal(containers.has("dh-z-engine"), false);
  assert.equal(volumes.has("dh-z-1-engine"), false);
  assert.equal(volumes.has("dh-y-1-engine"), false);
  assert.ok(containers.has("dh-a-engine"));
  assert.ok(volumes.has("dh-a-1-engine"));
  assert.match(
    callOf(calls, "ps", "--all", "--filter", "label=deckhand.owner=dh").join(" "),
    /label=deckhand\.owner=dh/,
  );
});

test("relink: an engine of a run still starting stays", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { r, containers } = runner({
    // The sandbox's own `docker run` waits until relink() has looked.
    before: (args) => args[0] === "run" && args.includes("dh-a") && held,
  });
  const starting = r.start(withEngine());
  while (!containers.has("dh-a-engine")) await new Promise((resolve) => setImmediate(resolve));
  await r.relink();
  assert.ok(containers.has("dh-a-engine"));
  release();
  await starting;
});

test("start: an engine a previous run of the task left behind goes first", async () => {
  const { r, containers } = runner();
  containers.set("dh-a-engine", { engine: "dh-a-0", running: true });
  await r.start(withEngine());
  assert.equal(containers.get("dh-a-engine").engine, "dh-a-1");
});
