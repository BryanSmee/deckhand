// What a research run is prepared with (preparation.mjs), down to its sandbox's spec: nothing of
// the repo's but its issue's thread.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RunError } from "../listener/access.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { createPreparation } from "../listener/preparation.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { sandboxSpec } from "../listener/sandbox-spec.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const REPO_YAML = `setup: npm ci
instructions: AGENTS.md
dockerfile: Dockerfile
caches: [/home/node/.npm]
mounts: [/srv/data]
`;

const comment = (n) => ({
  user: { login: n % 2 ? "alice" : "deckhand[bot]" },
  created_at: "2026-10-17T10:00:00Z",
  body: `comment ${n}`,
});

// A preparation for org/repo with the grant `text` and `comments` on issue #12, and what it
// asked of the images and GitHub.
function prepared(t, text, comments = [comment(1), comment(2)]) {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "org"));
  writeFileSync(join(dir, "org", "repo.yaml"), text);
  const config = testConfig({ GRANTS_DIR: dir });
  const calls = [];
  const fail = (what) => () => assert.fail(`a research run asked for ${what}`);
  const ctx = {
    config,
    log: () => {},
    shotsDir: tempDir(t),
    images: {
      installAgent: async (agent) => calls.push(`install ${agent.name}`),
      imageFor: fail("the repo's image"),
      caches: fail("the repo's caches"),
    },
    egressCa: fail("the egress CA"),
    broker: { allow: fail("branches"), runOf: fail("its run") },
    github: async (repo, method, path) => {
      calls.push(`${method} ${path}`);
      const body = path.includes("/comments")
        ? comments.slice(...(path.endsWith("page=1") ? [0, 100] : [100, 200]))
        : {
            title: "Which queue library?",
            body: "Compare them.",
            user: { login: "alice" },
            created_at: "2026-10-01T09:30:00Z",
          };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
  const notes = [];
  const task = {
    repo: "org/repo",
    base: "main",
    kind: "issue",
    number: 12,
    name: "deckhand-org-repo-12",
    live: {
      id: "deckhand-org-repo-12-1",
      key: "org/repo#12",
      mode: "research",
      light: true,
      secret: "s".repeat(32),
      record: { agent: "claude", model: "opus", effort: "high" },
      logFile: { write: () => {} },
    },
  };
  const { settings } = parseRepoConfig(REPO_YAML, config);
  const run = () =>
    createPreparation(ctx).prepareRun(task, [{}], { settings, message: "hi" }, (m) =>
      notes.push(m),
    );
  return { run, task, config, calls, notes };
}

test("a research run: the base image, no mounts, caches, engine, CA, screenshots or setup", async (t) => {
  const { run, task, config, calls } = prepared(t, "allow_research: true\ncached_hosts: [x.org]\n");
  const parts = await run();
  assert.deepEqual(calls, [
    "install claude",
    "GET /repos/org/repo/issues/12",
    "GET /repos/org/repo/issues/12/comments?per_page=100&page=1",
  ]);
  assert.deepEqual(task.live.hosts, ["*"]);
  assert.deepEqual(task.live.cached, []);
  assert.deepEqual(task.live.branches, []);
  assert.equal(parts.engine, null);
  assert.equal(parts.ca, null);
  assert.equal(parts.message, "hi");
  const bot = { name: "deckhand[bot]", email: "bot@example" };
  const agent = agentFor("claude");
  const spec = sandboxSpec(
    { config, task, agent, bot, publicUrl: "https://deckhand.example" },
    "p",
    "m",
    {
      ...parts.prepared,
      ...parts.access,
      engine: parts.engine,
      ca: parts.ca,
      digest: parts.digest,
    },
  );
  assert.equal(spec.image, config.image);
  assert.equal(spec.engine, undefined);
  assert.equal(spec.ca, undefined);
  const args = spec.args.join(" ");
  // Volumes of its own, which no work or light run mounts; nothing else of the repo's.
  assert.match(args, /-v deckhand-org-repo-12-research-workspace:\/workspace/);
  assert.doesNotMatch(args, /-light-|deckhand-org-repo-12-workspace/);
  assert.doesNotMatch(args, /type=bind|npm|screenshots|volume-subpath/);
  assert.equal(spec.env.SANDBOX_NO_CLONE, "1");
  assert.equal(spec.env.SANDBOX_LIGHT, "1");
  assert.equal(spec.env.SANDBOX_SETUP, "");
  assert.equal(spec.env.SANDBOX_INSTRUCTIONS, "");
  assert.equal(spec.env.TASK_ISSUE, "");
  assert.equal(spec.env.TASK_MODE, "research");
  assert.equal(spec.env.SCREENSHOT_DIR, "");
  assert.equal(spec.env.SCREENSHOT_URL, "");
});

test("a research run reads its issue's thread: title, description, the last 50 comments", async (t) => {
  const many = Array.from({ length: 120 }, (_, i) => comment(i + 1));
  many[119].body = `the run's secret: ${"s".repeat(32)}`;
  const { run, notes } = prepared(t, "allow_research: true\n", many);
  const { digest } = await run();
  assert.match(
    digest,
    /^# Which queue library\?\n\norg\/repo#12, opened by @alice on 2026-10-01 09:30 UTC\n\nCompare them\./,
  );
  assert.match(digest, /## Comments \(the last 50 of 120\)/);
  assert.doesNotMatch(digest, /comment 70\n/);
  assert.match(digest, /### @alice, 2026-10-17 10:00 UTC\n\ncomment 71\n/);
  assert.doesNotMatch(digest, /s{32}/);
  assert.ok(notes.includes("Thread: #12, 50 of 120 comment(s)"));
});

test("a research run without allow_research stops before anything is asked for", async (t) => {
  const { run, calls } = prepared(t, "hosts: [pypi.org]\n");
  await assert.rejects(
    run(),
    (e) => e instanceof RunError && /allow_research: true/.test(e.message),
  );
  assert.deepEqual(calls, []);
});

// A work run on issue #12 asked from pull request #7, from `head` (a repo's full name), and
// what it asked of the images. `imageFor`: the images' own, `written`: what goes to its log,
// `ca`: the egress proxy's CA certificate, or null.
async function workRun(t, head, { imageFor, written = [], ca = "the CA" } = {}) {
  const dir = realpathSync(tempDir(t));
  const config = testConfig({ GRANTS_DIR: dir });
  const calls = [];
  const ctx = {
    config,
    log: () => {},
    shotsDir: tempDir(t),
    images: {
      installAgent: async () => {},
      imageFor: imageFor ?? (async () => config.image),
      caches: async (repo, paths) => {
        calls.push(`caches ${paths.join(" ")}`);
        return ["-v", "cache-npm:/home/node/.npm"];
      },
    },
    egressCa: async () => ca,
    broker: { allow: () => {}, runOf: () => ({ push: true }) },
    github: async () =>
      new Response(JSON.stringify({ head: { ref: "feat", repo: { full_name: head } } }), {
        status: 200,
      }),
  };
  const notes = [];
  const task = {
    repo: "org/repo",
    base: "main",
    kind: "issue",
    number: 12,
    name: "deckhand-org-repo-12",
    live: {
      id: "deckhand-org-repo-12-1",
      key: "org/repo#12",
      mode: "work",
      light: false,
      secret: "s".repeat(32),
      record: { agent: "claude", model: "opus", effort: "high" },
      logFile: { write: (text) => written.push(text) },
    },
  };
  const { settings } = parseRepoConfig("setup: npm ci\ncaches: [/home/node/.npm]\n", config);
  const parts = await createPreparation(ctx).prepareRun(
    task,
    [{ replyTo: 7 }],
    { settings, message: "hi" },
    (m) => notes.push(m),
  );
  return { parts, task, calls, notes };
}

test("a work run with a comment from a fork's pull request gets no caches, and says so", async (t) => {
  const { parts, task, calls, notes } = await workRun(t, "someone/repo");
  assert.equal(task.live.fork, true);
  assert.deepEqual(parts.prepared.cacheArgs, []);
  assert.deepEqual(calls, []);
  assert.ok(notes.includes("No caches: a pull request from a fork"));
  assert.deepEqual(task.live.branches, ["issue-12-*"]);
});

test("a work run with a comment from the repo's own pull request keeps its caches", async (t) => {
  const { parts, task, calls, notes } = await workRun(t, "org/repo");
  assert.equal(task.live.fork, false);
  assert.deepEqual(parts.prepared.cacheArgs, ["-v", "cache-npm:/home/node/.npm"]);
  assert.deepEqual(calls, ["caches /home/node/.npm"]);
  assert.ok(!notes.some((n) => /fork/.test(n)));
  assert.deepEqual(task.live.branches, ["issue-12-*", "feat"]);
});

test("a work run trusts the egress proxy's CA without cached hosts: its GitHub calls are relayed", async (t) => {
  const { parts, task } = await workRun(t, "org/repo");
  assert.equal(parts.ca, "the CA");
  assert.deepEqual(task.live.cached, []);
  await assert.rejects(
    workRun(t, "org/repo", { ca: null }),
    (e) => e instanceof RunError && /no CA, and its calls to GitHub go through it/.test(e.message),
  );
});

test("a run whose image builds: its log's image phase, then setup again", async (t) => {
  const written = [];
  const imageFor = async ({ onBuild, output }) => {
    onBuild("deckhand-repo:abc");
    output("#1 [a 1/1] RUN make\n#1 DONE 1.0s\n");
    return "deckhand-repo:abc";
  };
  const { task } = await workRun(t, "org/repo", { imageFor, written });
  const lines = written.map((w) => (w.startsWith("{") ? JSON.parse(w) : w));
  // By whole lines, the step's first after the time it started (runlog.mjs buildOutput()).
  assert.deepEqual(
    lines.map((l) => l.phase ?? l.event ?? l),
    ["image", "at", "#1 [a 1/1] RUN make\n", "#1 DONE 1.0s\n", "setup"],
  );
  assert.equal(typeof lines[1].at, "number");
  assert.equal(task.live.logPhase, "setup");
  // Scheduled again on the dashboard until its agent starts (board.mjs runState()).
  assert.equal(task.live.record.phase, "setup");
});

test("a run whose image is built already: no image phase", async (t) => {
  const written = [];
  const { task } = await workRun(t, "org/repo", { written });
  // The run starts in no phase here (runs.mjs enters setup first): setup is a change.
  assert.deepEqual(
    written.map((w) => JSON.parse(w).phase),
    ["setup"],
  );
  assert.equal(task.live.logPhase, "setup");
});

// An analysis's digest: the full one only when the analysis was asked for on a private repo
// that GitHub still says is private when it starts; anything else, the public one.
test("an analysis's digest is the public one unless the repo was and still is private", async (t) => {
  const cases = [
    [{ asked: true, now: true }, false],
    [{ asked: true, now: false }, true],
    [{ asked: true, now: "fails" }, true],
    [{ asked: false, now: true }, true],
    // Queued before analyses said.
    [{ asked: undefined, now: true }, true],
  ];
  for (const [{ asked, now }, expected] of cases) {
    const seen = [];
    const ctx = {
      config: testConfig(),
      log: () => {},
      analysis: {
        digest: (repo, ids, selection, options) => {
          seen.push(options);
          return { text: "digest", included: ids, left: [] };
        },
      },
      github: async () =>
        now === "fails" ? new Response("{}", { status: 502 }) : Response.json({ private: now }),
    };
    const task = {
      repo: "org/repo",
      live: { secret: "s".repeat(32), record: { agent: "claude" } },
    };
    const analysis = { runs: ["r1"], kinds: ["work"], outcomes: ["error"], private: asked };
    const text = await createPreparation(ctx).analysisDigest(task, [{ analysis }], () => {});
    assert.equal(text, "digest");
    assert.deepEqual(seen, [{ isPublic: expected }], JSON.stringify({ asked, now }));
  }
});
