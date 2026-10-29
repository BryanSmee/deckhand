import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { previewEvent } from "../listener/events.mjs";
import { createPreviews, MAX_WAITING, previewHook } from "../listener/previews.mjs";
import { createDockerJobs } from "../listener/runner/jobs.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const config = testConfig({ ALLOWED_USERS: "a", DOCKER_SOCKET: "/run/docker.sock" });
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
  // Removed when the file's tests end: hooks still running after a test write their logs here.
  const logDir = tempDir(null, "deckhand-previews-");
  const previews = createPreviews({
    config,
    containers: createDockerJobs({ config, docker }).preview,
    checkout: async () => tempDir(null, "deckhand-ctx-"),
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
  const narrowed = testConfig({ ALLOWED_USERS: "a", ALLOWED_REPOS: "org/b" });
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

test("a repo's waiting hooks are capped, and a newer event replaces its pull request's", async () => {
  const { previews, calls, inputs, release } = setup();
  const run = (number, action, repo = "org/a") =>
    previews.run({
      repo,
      event: "pull_request",
      payload: { action, pull_request: { number } },
      ref: "trunk",
      hook,
      image: "x",
    });
  const first = run(1, "opened");
  await new Promise((resolve) => setTimeout(resolve, 10));
  // #2 opened, then pushed to while it waits: only its latest event runs.
  const opened = run(2, "opened");
  const pushed = run(2, "synchronize");
  assert.equal(await opened, null);
  const third = run(3, "opened");
  const fourth = run(4, "opened");
  assert.equal(MAX_WAITING, 3);
  // Full: a fifth pull request's event is dropped, another repo's isn't.
  assert.equal(await run(5, "opened"), null);
  const other = run(5, "opened", "org/b");
  assert.deepEqual(
    previews.status().map((h) => `${h.repo} ${h.action} ${h.state}`),
    [
      "org/a opened running",
      "org/a synchronize waiting",
      "org/a opened waiting",
      "org/a opened waiting",
      "org/b opened running",
    ],
  );
  release();
  assert.deepEqual(await Promise.all([first, pushed, third, fourth, other]), [0, 0, 0, 0, 0]);
  assert.deepEqual(
    inputs.map((i) => JSON.parse(i)).map((p) => `${p.pull_request.number} ${p.action}`),
    ["1 opened", "5 opened", "2 synchronize", "3 opened", "4 opened"],
  );
  assert.equal(calls.filter((c) => c[0] === "start").length, 5);
  assert.deepEqual(previews.status(), []);
});

test("a runner without preview containers refuses the hook: nothing runs", async () => {
  const logs = [];
  let checkouts = 0;
  const previews = createPreviews({
    config,
    containers: null,
    checkout: async () => (checkouts++, tempDir(null, "deckhand-ctx-")),
    logDir: tempDir(null, "deckhand-previews-"),
    log: (line) => logs.push(line),
  });
  const code = await previews.run({
    repo: "org/a",
    event: "pull_request",
    payload: { action: "opened" },
    ref: "trunk",
    hook,
    image: "docker:cli",
  });
  assert.equal(code, null);
  assert.equal(checkouts, 0);
  assert.match(logs.join("\n"), /the docker runner runs no preview hooks/);
});

test("previewHook: a runner without preview containers skips it before any image or queue", async () => {
  const skipped = [];
  const ctx = {
    config: { ...config, runner: "other" },
    skip: (why) => skipped.push(why),
    repoSettings: async () => ({
      settings: { preview: { command: "./preview.sh" }, dockerfile: "Dockerfile" },
      errors: [],
    }),
    images: { imageFor: async () => assert.fail("no image for a hook that can't run") },
    previews: { runs: false, run: async () => assert.fail("not queued") },
  };
  await previewHook(ctx, { repo: "org/a", base: "trunk", event: "pull_request" }, {});
  assert.deepEqual(skipped, [
    "pull_request: preview hook of org/a not run: the other runner runs no preview hooks",
  ]);
});
