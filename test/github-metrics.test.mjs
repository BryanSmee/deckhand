// The github service's metrics (../github/metrics.mjs): its API calls by caller and status, the
// lowest rate limit GitHub's answers said, git operations, pushes refused, the mirrors' size.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { githubMetrics } from "../github/metrics.mjs";
import { createRegistry } from "../lib/metrics.mjs";
import { isWindows, tempDir } from "./helpers.mjs";

// A sample's value in `text`, or undefined when it has none.
function sample(text, line) {
  const found = text.split("\n").find((l) => l.startsWith(`${line} `));
  return found === undefined ? undefined : Number(found.slice(line.length + 1));
}

function setup({ now = () => 1_800_000_000_000, fetch, mirrorDir } = {}) {
  const warned = [];
  const registry = createRegistry({ log: (line) => warned.push(line) });
  const metrics = githubMetrics(registry, { now, fetch, mirrorDir });
  return { registry, metrics, warned, render: () => registry.render() };
}

const limit = (resource, remaining, reset, size = 5000) => ({
  "x-ratelimit-resource": resource,
  "x-ratelimit-limit": String(size),
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(reset),
});

test("API calls by caller and status; an unknown status or caller is `other`, no answer `error`", async () => {
  const { metrics, render, warned } = setup();
  metrics.api({ caller: "edge", status: 200, seconds: 0.02 });
  metrics.api({ caller: "edge", status: 200, seconds: 0.2 });
  metrics.api({ caller: "proxy", status: 418, seconds: 1 });
  metrics.api({ caller: "proxy", status: null, seconds: 3 });
  metrics.api({ caller: "someone", status: 404, seconds: 0 });
  const text = await render();
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="edge",status="200"}'), 2);
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="proxy",status="other"}'), 1);
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="proxy",status="error"}'), 1);
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="other",status="404"}'), 1);
  assert.equal(sample(text, 'deckhand_github_api_call_duration_seconds_count{caller="edge"}'), 2);
  assert.equal(
    sample(text, 'deckhand_github_api_call_duration_seconds_bucket{caller="edge",le="0.025"}'),
    1,
  );
  assert.equal(warned.length, 2);
});

test("the rate limit: the lowest of the tokens' still in their window, and when it starts again", async () => {
  let clock = 1_800_000_000_000;
  const { metrics, render } = setup({ now: () => clock });
  const reset = clock / 1000 + 600;
  const seen = (auth, headers) =>
    metrics.api({ caller: "proxy", status: 200, seconds: 0, headers, authorization: auth });
  // Two installations; the first's latest answer is what counts for it.
  seen("token a", limit("core", 4000, reset));
  seen("token a", limit("core", 3990, reset));
  seen("token b", limit("core", 4500, reset - 300));
  seen("token b", limit("graphql", 4999, reset));
  // The App's JWT, a new one each minute: one key (its window Enterprise Cloud's, larger).
  seen("Bearer eyJ1", limit("core", 100, reset + 60));
  seen("Bearer eyJ2", limit("core", 4900, reset + 60, 15000));
  // No headers, a resource Deckhand doesn't watch, values that aren't numbers: nothing.
  seen("token c", null);
  seen("token c", limit("code_search", 1, reset));
  seen("token c", { ...limit("core", 0, reset), "x-ratelimit-remaining": "lots" });
  // No token (/setup's manifest conversion): the address's 60 an hour, no installation's.
  seen(null, limit("core", 59, reset));
  seen("", limit("core", 59, reset));
  let text = await render();
  assert.equal(sample(text, 'deckhand_github_rate_limit_remaining{resource="core"}'), 3990);
  assert.equal(sample(text, 'deckhand_github_rate_limit_reset_seconds{resource="core"}'), 600);
  assert.equal(sample(text, 'deckhand_github_rate_limit_limit{resource="core"}'), 5000);
  assert.equal(sample(text, 'deckhand_github_rate_limit_remaining{resource="graphql"}'), 4999);
  assert.equal(sample(text, 'deckhand_github_rate_limit_remaining{resource="search"}'), undefined);
  assert.doesNotMatch(text, /code_search|resource="other"/);
  // Once a's window is over, b's is gone too: the App's is the one left.
  clock += 601_000;
  text = await render();
  assert.equal(sample(text, 'deckhand_github_rate_limit_remaining{resource="core"}'), 4900);
  assert.equal(sample(text, 'deckhand_github_rate_limit_reset_seconds{resource="core"}'), 59);
  assert.equal(sample(text, 'deckhand_github_rate_limit_limit{resource="core"}'), 15000);
  assert.equal(sample(text, 'deckhand_github_rate_limit_remaining{resource="graphql"}'), undefined);
});

test("the App's fetch: each call the caller's in flight (`github` outside one), failures `error`", async () => {
  const fetch = async (url, init) => {
    if (url.endsWith("/down")) throw new Error("connect ECONNREFUSED");
    assert.equal(init.headers.authorization, "token t");
    return new Response("{}", {
      status: url.endsWith("/missing") ? 404 : 200,
      headers: limit("core", 42, 1_800_000_100),
    });
  };
  const { metrics, render } = setup({ fetch });
  const headers = { authorization: "token t" };
  await metrics.as("runner", () => metrics.fetch("https://api.test/ok", { headers }));
  await metrics.as("runner", async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return metrics.fetch("https://api.test/missing", { headers });
  });
  await metrics.fetch("https://api.test/ok", { headers });
  await assert.rejects(
    metrics.as("orchestrator", () => metrics.fetch("https://api.test/down", { headers })),
    /ECONNREFUSED/,
  );
  const text = await render();
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="runner",status="200"}'), 1);
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="runner",status="404"}'), 1);
  assert.equal(sample(text, 'deckhand_github_api_calls_total{caller="github",status="200"}'), 1);
  assert.equal(
    sample(text, 'deckhand_github_api_calls_total{caller="orchestrator",status="error"}'),
    1,
  );
  assert.equal(sample(text, 'deckhand_github_rate_limit_remaining{resource="core"}'), 42);
});

test("git operations and pushes refused, by their declared labels", async () => {
  const { metrics, render } = setup();
  metrics.git("push", "ok");
  metrics.git("push", "refused");
  metrics.refused("default_branch");
  metrics.refused("made up");
  metrics.git("clone", "ok");
  const text = await render();
  assert.equal(sample(text, 'deckhand_git_operations_total{op="push",result="ok"}'), 1);
  assert.equal(sample(text, 'deckhand_git_operations_total{op="push",result="refused"}'), 1);
  assert.equal(sample(text, 'deckhand_git_operations_total{op="clone",result="ok"}'), 1);
  assert.equal(sample(text, 'deckhand_pushes_refused_total{reason="default_branch"}'), 1);
  assert.equal(sample(text, 'deckhand_pushes_refused_total{reason="other"}'), 1);
});

test("the mirrors' size: their files' bytes, read again a minute later; none yet is 0", async (t) => {
  const dir = tempDir(t);
  const mirrors = join(dir, "git-mirrors");
  let clock = 0;
  const { render } = setup({ now: () => clock, mirrorDir: mirrors });
  assert.equal(sample(await render(), "deckhand_mirror_bytes"), 0);
  clock += 60_000;
  mkdirSync(join(mirrors, "org", "repo.git", "objects"), { recursive: true });
  writeFileSync(join(mirrors, "org", "repo.git", "HEAD"), "x".repeat(10));
  writeFileSync(join(mirrors, "org", "repo.git", "objects", "pack"), "y".repeat(1000));
  assert.equal(sample(await render(), "deckhand_mirror_bytes"), 1010);
  writeFileSync(join(mirrors, "org", "more"), "z".repeat(5));
  // Kept between scrapes.
  assert.equal(sample(await render(), "deckhand_mirror_bytes"), 1010);
  clock += 60_000;
  assert.equal(sample(await render(), "deckhand_mirror_bytes"), 1015);
});

test(
  "the mirrors' size follows no symlink, to a file or a folder",
  { skip: isWindows && "symlinks need a privilege on Windows" },
  async (t) => {
    const dir = tempDir(t);
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "big"), "x".repeat(4096));
    const mirrors = join(dir, "git-mirrors");
    mkdirSync(mirrors);
    writeFileSync(join(mirrors, "HEAD"), "abc");
    symlinkSync(outside, join(mirrors, "folder"), "dir");
    symlinkSync(join(outside, "big"), join(mirrors, "file"));
    const { render } = setup({ mirrorDir: mirrors });
    // The links' own few bytes at most, never what they point at.
    const bytes = sample(await render(), "deckhand_mirror_bytes");
    assert.ok(bytes >= 3 && bytes < 4096, String(bytes));
  },
);
