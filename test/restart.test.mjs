// Runs a previous listener left behind (restart.mjs): what the broker knows of them again.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createRestart } from "../listener/restart.mjs";
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
