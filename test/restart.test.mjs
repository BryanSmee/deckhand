// Runs a previous listener left behind (restart.mjs): what the broker knows of them again.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { board } from "../listener/board.mjs";
import { createRestart, respelled, spellings } from "../listener/restart.mjs";
import { loadRuns } from "../listener/runlog.mjs";
import { tempDir } from "./helpers.mjs";

// A run's saved state, as saveLive() writes it.
function saveRun(dir, id, issue, record) {
  const secret = `secret-${id}`;
  const saved = {
    task: { repo: "org/repo", id: issue, kind: "issue" },
    id,
    mode: "work",
    light: false,
    secret,
    record: { id, key: `org/repo#${issue}`, ...record },
    handled: [],
    unanswered: [],
  };
  writeFileSync(join(dir, `${id}.live.json`), JSON.stringify(saved));
  return secret;
}

test("a restored run's calls go to its provider, or its agent's own when none was saved", (t) => {
  const dir = tempDir(t);
  const broker = createBroker({ app: () => null });
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: [],
    runsById: new Map(),
    runner: { closed: () => false },
    broker,
    running: 0,
  };
  const fallback = saveRun(dir, "r1", 1, { agent: "claude", provider: "openrouter" });
  const codex = saveRun(dir, "r2", 2, { agent: "codex" });
  const old = saveRun(dir, "r3", 3, {});
  createRestart(ctx).restoreRuns();
  assert.equal(broker.runOf(fallback).provider, "openrouter");
  assert.equal(broker.runOf(codex).provider, "openai");
  // Saved before records named their agent: Claude Code's.
  assert.equal(broker.runOf(old).provider, "anthropic");
  // A refused call is a line in that run's log.
  broker.runOf(codex).note("Deckhand refused the agent's call GET /openai/files");
  assert.match(readFileSync(join(dir, "r2.log"), "utf8"), /"event":"note".*GET \/openai\/files/);
});

test("runs, a run going and a queue under two spellings of a repo load as one, the newest's", (t) => {
  const dir = tempDir(t);
  const summary = (id, repo, n, startedAt) => {
    writeFileSync(join(dir, `${id}.log`), "");
    const run = { id, key: `${repo}#${n}`, repo, status: "ok", startedAt, finishedAt: startedAt };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(run));
  };
  // A webhook's run, then an older one from a lowercase dashboard address.
  summary("a-1", "storywake/storywake", 1, 1000);
  summary("b-2", "Storywake/storywake", 2, 2000);
  summary("c-3", "org/other", 3, 3000);
  // Still going, from the lowercase address: older than the webhook's.
  writeFileSync(
    join(dir, "d-1.live.json"),
    JSON.stringify({
      task: { repo: "storywake/storywake", id: "1", kind: "issue" },
      id: "d-1",
      mode: "work",
      light: false,
      secret: "s",
      record: {
        id: "d-1",
        key: "storywake/storywake#1",
        repo: "storywake/storywake",
        startedAt: 1500,
      },
      handled: [],
      unanswered: [],
    }),
  );
  writeFileSync(
    join(dir, "queue.json"),
    JSON.stringify([
      { repo: "storywake/storywake", id: "4", kind: "issue", pending: [], next: { model: "x" } },
    ]),
  );
  const ctx = {
    config: { dataDir: dir },
    log: () => {},
    tasks: new Map(),
    logDir: dir,
    runs: loadRuns(dir, { log: () => {} }),
    runsById: new Map(),
    runner: { closed: () => false },
    broker: createBroker({ app: () => null }),
    running: 0,
  };
  const restart = createRestart(ctx);
  restart.restoreRuns();
  restart.loadQueue();
  const repos = new Set(ctx.runs.map((r) => r.repo));
  assert.deepEqual([...repos].sort(), ["Storywake/storywake", "org/other"]);
  assert.deepEqual(ctx.runs.find((r) => r.id === "a-1").key, "Storywake/storywake#1");
  assert.deepEqual([...ctx.tasks.keys()].sort(), [
    "Storywake/storywake#1",
    "Storywake/storywake#4",
  ]);
  assert.equal(ctx.tasks.get("Storywake/storywake#1").repo, "Storywake/storywake");
  assert.equal(ctx.tasks.get("Storywake/storywake#1").live.record.repo, "Storywake/storywake");
  // The dashboard's tasks: one repo.
  const tasks = board({ runs: ctx.runs, queued: [], brainstorms: [] });
  assert.deepEqual(tasks.map((t) => t.key).sort(), [
    "Storywake/storywake#1",
    "Storywake/storywake#2",
    "org/other#3",
  ]);
});

test("spellings: the most recent run's, whatever the case of the name asked for", () => {
  const spelled = spellings([
    { repo: "org/App", startedAt: 1 },
    { repo: "Org/app", startedAt: 3 },
    { repo: "org/app", startedAt: 2 },
    { repo: null, startedAt: 4 },
  ]);
  assert.equal(spelled("ORG/APP"), "Org/app");
  assert.equal(spelled("org/other"), "org/other");
  assert.equal(respelled("org/APP#pr-3", spelled), "Org/app#pr-3");
  assert.equal(respelled("not a key", spelled), "not a key");
});
