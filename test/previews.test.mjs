import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { previewEvent } from "../listener/events.mjs";
import { createPreviews } from "../listener/previews.mjs";

const config = loadConfig({ ALLOWED_USERS: "a", DOCKER_SOCKET: "/run/docker.sock" });
const hook = { command: "./preview.sh", image: "docker:cli", timeoutMinutes: 1 };

function setup() {
  const calls = [];
  const inputs = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const docker = async (args, options = {}) => {
    calls.push(args);
    if (args[0] === "start") {
      inputs.push(options.input);
      options.onData?.("deployed\n");
      await gate;
    }
    return { code: 0, out: "", err: "" };
  };
  const logDir = mkdtempSync(join(tmpdir(), "deckhand-previews-"));
  const previews = createPreviews({
    config,
    docker,
    checkout: async () => mkdtempSync(join(tmpdir(), "deckhand-ctx-")),
    logDir,
  });
  return { previews, calls, inputs, release, logDir };
}

test("pull_request and workflow_run deliveries go to the preview hook", () => {
  const p = {
    installation: { id: 1 },
    repository: { full_name: "org/a", default_branch: "trunk" },
  };
  assert.deepEqual(previewEvent(config, "pull_request", p), {
    repo: "org/a",
    base: "trunk",
    event: "pull_request",
  });
  assert.equal(previewEvent(config, "workflow_run", p).event, "workflow_run");
  assert.equal(previewEvent(config, "issue_comment", p), null);
  assert.equal(previewEvent(config, "pull_request", { ...p, installation: null }), null);
  const narrowed = loadConfig({ ALLOWED_USERS: "a", ALLOWED_REPOS: "org/b" });
  assert.equal(previewEvent(narrowed, "pull_request", p), null);
});

test("the hook runs with the event on stdin and the Docker socket, and is busy until it exits", async () => {
  const { previews, calls, inputs, release, logDir } = setup();
  const payload = { action: "opened", number: 3 };
  const done = previews.run({
    repo: "org/a",
    event: "pull_request",
    payload,
    ref: "trunk",
    hook,
    image: "docker:cli",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(previews.status().length, 1);
  assert.equal(previews.status()[0].state, "running");
  // dashboard/src/types.ts's Preview: change both together.
  assert.deepEqual(Object.keys(previews.status()[0]).sort(), [
    "action",
    "event",
    "name",
    "repo",
    "since",
    "state",
  ]);
  const create = calls.find((c) => c[0] === "create");
  assert.ok(create.join(" ").includes("-v /run/docker.sock:/var/run/docker.sock"));
  assert.ok(create.join(" ").includes("-e GITHUB_EVENT_NAME=pull_request"));
  assert.equal(create.at(-1), "./preview.sh");
  assert.ok(create.includes("docker:cli"));
  assert.ok(calls.some((c) => c[0] === "cp" && c[2].endsWith(":/deckhand-checkout")));
  assert.deepEqual(JSON.parse(inputs[0]), payload);
  release();
  await done;
  assert.deepEqual(previews.status(), []);
  assert.deepEqual(calls.at(-1).slice(0, 2), ["rm", "-f"]);
  const [name] = create.slice(create.indexOf("--name") + 1);
  assert.equal(readFileSync(join(logDir, `${name}.log`), "utf8"), "deployed\n");
});

test("a repo's hooks run one at a time, in order", async () => {
  const { previews, calls, release } = setup();
  const run = (n) =>
    previews.run({
      repo: "org/a",
      event: "pull_request",
      payload: { number: n },
      ref: "trunk",
      hook,
      image: "x",
    });
  const both = Promise.all([run(1), run(2)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    previews.status().map((h) => h.state),
    ["running", "waiting"],
  );
  assert.equal(calls.filter((c) => c[0] === "start").length, 1);
  release();
  await both;
  assert.equal(calls.filter((c) => c[0] === "start").length, 2);
});
