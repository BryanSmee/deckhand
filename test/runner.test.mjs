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
import { CLOSE, createDockerRunner } from "../listener/runner/docker.mjs";

const config = { prefix: "dh", network: "dh-sandboxes", runsVolume: "dh-runs" };

function runner({ answers = {}, spawn } = {}) {
  const calls = [];
  const docker = async (args, opts = {}) => {
    calls.push({ args, env: opts.env });
    return answers[args[0]] ?? { code: 0, out: "", err: "" };
  };
  const inboxDir = mkdtempSync(join(tmpdir(), "deckhand-runs-"));
  return { r: createDockerRunner({ config, docker, spawn, inboxDir }), calls, inboxDir };
}

test("start: detached, labelled, secrets by name only, its inbox read-only", async () => {
  const { r, calls, inboxDir } = runner();
  await r.start({
    run: "dh-org-repo-12-1",
    name: "dh-org-repo-12",
    image: "dh-sandbox",
    labels: { "deckhand.task": "org/repo#12" },
    env: { DECKHAND_RUN_SECRET: "s3cret", UNSET: undefined },
    args: ["--network", "dh-sandboxes"],
  });
  const [{ args, env }] = calls;
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
  assert.equal(readFileSync(join(inboxDir, "dh-org-repo-12-1", "inbox.jsonl"), "utf8"), "");
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
  const { r } = runner({ answers: { inspect: { code: 1, out: "", err: "No such object" } } });
  assert.equal(await r.state("x"), null);
  assert.equal(await r.address("x"), null);
  const found = runner({
    answers: { inspect: { code: 0, out: '{"dh-sandboxes":{"IPAddress":"10.0.0.2"}}', err: "" } },
  });
  assert.deepEqual(await found.r.address("x"), ["10.0.0.2"]);
});

test("checkNetwork: refuses a network with a route out, until it is fixed", async () => {
  const answers = { network: { code: 0, out: "false", err: "" } };
  const { r, calls } = runner({ answers });
  await assert.rejects(r.checkNetwork(), /dh-sandboxes is not internal/);
  answers.network = { code: 0, out: "true", err: "" };
  await r.checkNetwork();
  await r.checkNetwork();
  assert.equal(calls.length, 2); // checked until it passes once
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
