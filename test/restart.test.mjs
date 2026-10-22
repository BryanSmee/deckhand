// Runs a previous listener left behind (restart.mjs): what the broker knows of them again.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { board } from "../listener/board.mjs";
import { createRestart } from "../listener/restart.mjs";
import { ambiguous, respellMap, respelled, spellings } from "../listener/spelling.mjs";
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

// A data dir whose runs, run going and queue have one repo under two spellings: `live` the
// running one's, `newest` the last finished run's.
function twoSpellings(t, { live, newest }) {
  const dir = tempDir(t);
  const summary = (id, repo, n, startedAt) => {
    writeFileSync(join(dir, `${id}.log`), "");
    const run = { id, key: `${repo}#${n}`, repo, status: "ok", startedAt, finishedAt: startedAt };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(run));
  };
  summary("a-1", "Storywake/storywake", 1, 1000);
  summary("b-2", newest, 2, 3000);
  summary("c-3", "org/other", 3, 3000);
  writeFileSync(
    join(dir, "d-5.live.json"),
    JSON.stringify({
      task: { repo: live, id: "5", kind: "issue" },
      id: "d-5",
      mode: "work",
      light: false,
      secret: "s",
      record: { id: "d-5", key: `${live}#5`, repo: live, startedAt: 2000 },
      handled: [],
      unanswered: [],
    }),
  );
  // The same task queued under both: one task once loaded.
  writeFileSync(
    join(dir, "queue.json"),
    JSON.stringify([
      { repo: "storywake/storywake", id: "4", kind: "issue", pending: [], next: { model: "x" } },
      {
        repo: "STORYWAKE/storywake",
        id: "4",
        kind: "issue",
        pending: [],
        next: { effort: "high" },
      },
    ]),
  );
  return {
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
}

async function restarted(ctx, options) {
  const restart = createRestart(ctx);
  const spelled = options && (await restart.unifySpellings(options));
  restart.restoreRuns();
  restart.loadQueue();
  return spelled;
}

test("two spellings of a repo load as one: GitHub's, asked for that repo alone", async (t) => {
  const ctx = twoSpellings(t, { live: "storywake/storywake", newest: "storywake/storywake" });
  const asked = [];
  const nameOf = async (repo) => {
    asked.push(repo);
    return "Storywake/storywake";
  };
  const spelled = await restarted(ctx, { nameOf, keys: ["storywake/STORYWAKE#9"] });
  assert.equal(asked.length, 1);
  assert.equal(spelled("STORYWAKE/STORYWAKE"), "Storywake/storywake");
  const repos = new Set(ctx.runs.map((r) => r.repo));
  assert.deepEqual([...repos].sort(), ["Storywake/storywake", "org/other"]);
  assert.equal(ctx.runs.find((r) => r.id === "b-2").key, "Storywake/storywake#2");
  assert.deepEqual([...ctx.tasks.keys()].sort(), [
    "Storywake/storywake#4",
    "Storywake/storywake#5",
  ]);
  assert.deepEqual(ctx.tasks.get("Storywake/storywake#4").next, { effort: "high", model: "x" });
  assert.equal(ctx.tasks.get("Storywake/storywake#5").live.record.repo, "Storywake/storywake");
  // The dashboard's tasks: one repo.
  const tasks = board({ runs: ctx.runs, queued: [], brainstorms: [] });
  assert.deepEqual(tasks.map((t) => t.key).sort(), [
    "Storywake/storywake#1",
    "Storywake/storywake#2",
    "Storywake/storywake#5",
    "org/other#3",
  ]);
});

test("two spellings without GitHub's: the run going keeps the webhooks' key, newer runs or not", async (t) => {
  for (const nameOf of [
    null,
    async () => {
      throw new Error("GitHub down");
    },
    // Renamed to another repo: not a spelling of this one.
    async () => "Elsewhere/storywake",
    // No answer in time.
    () => new Promise(() => {}),
  ]) {
    const ctx = twoSpellings(t, { live: "Storywake/storywake", newest: "storywake/storywake" });
    await restarted(ctx, nameOf && { nameOf, waitMs: 20 });
    assert.equal(ctx.runs.find((r) => r.id === "b-2").key, "Storywake/storywake#2");
    assert.ok(ctx.tasks.get("Storywake/storywake#5").running);
  }
});

test("spellings: GitHub's, else a run going's, else the most recent; whatever the case asked", () => {
  const records = [
    { repo: "org/App", startedAt: 1, live: true },
    { repo: "Org/app", startedAt: 3 },
    { repo: "org/app", startedAt: 2 },
    { repo: "org/other" },
    { repo: null, startedAt: 4 },
  ];
  assert.deepEqual(ambiguous(records), ["org/App"]);
  assert.equal(spellings(records)("ORG/APP"), "org/App");
  assert.equal(spellings(records.slice(1))("ORG/APP"), "Org/app");
  const spelled = spellings(records, new Map([["org/app", "ORG/App"]]));
  assert.equal(spelled("org/app"), "ORG/App");
  assert.equal(spelled("org/other"), "org/other");
  assert.equal(spelled("new/one"), "new/one");
  assert.equal(respelled("org/APP#pr-3", spelled), "ORG/App#pr-3");
  assert.equal(respelled("not a key", spelled), "not a key");
  // State keyed by task: the entry already under the new key stays.
  const map = new Map([
    ["org/app#1", { repo: "org/app" }],
    ["ORG/App#1", { repo: "ORG/App", kept: true }],
    ["org/app#2", { repo: "org/app" }],
  ]);
  const fix = (v) => ({ ...v, repo: spelled(v.repo) });
  assert.equal(respellMap(map, spelled, fix), true);
  assert.deepEqual(Object.fromEntries(map), {
    "ORG/App#1": { repo: "ORG/App", kept: true },
    "ORG/App#2": { repo: "ORG/App" },
  });
  assert.equal(respellMap(map, spelled, fix), false);
});
