import assert from "node:assert/strict";
import test from "node:test";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { CACHE_MS, createHealth, reasonOf, STARTING_MS } from "../listener/health.mjs";
import { closedPort } from "./helpers.mjs";

const NOW = 1_800_000_000_000;

test("healthInfo: its start and the image's version, dev from source", () => {
  assert.deepEqual(
    healthInfo({ DECKHAND_VERSION: "1.4.0" }, () => 1000),
    { startedAt: 1000, version: "1.4.0" },
  );
  assert.equal(healthInfo({}, () => 1).version, "dev");
  // Only its own fields beside ok, startedAt and version.
  assert.deepEqual(healthAnswer({ startedAt: 1, version: "v", other: "x" }, { app: true }), {
    ok: true,
    startedAt: 1,
    version: "v",
    app: true,
  });
});

// A fake clock, and a fetch answering each service's URL from `answers` (name → a Response, an
// error to throw, or a function of the call's init).
function harness(answers, { urls, now = NOW } = {}) {
  const clock = { now };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    const name = new URL(url).hostname;
    const answer = answers[name];
    if (typeof answer === "function") return answer(init);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const health = createHealth({
    urls: urls ?? Object.fromEntries(Object.keys(answers).map((n) => [n, `http://${n}:8080`])),
    self: { name: "orchestrator", startedAt: NOW - 3_600_000, version: "1.4.0" },
    fetch,
    now: () => clock.now,
  });
  return { health, calls, clock };
}

const ok = (startedAt, extra = {}) =>
  Response.json({ ok: true, startedAt, version: "1.4.0", ...extra });
const refused = () =>
  Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const byName = (services) => Object.fromEntries(services.map((s) => [s.name, s]));

test("up, starting under 5 minutes, up at 5 minutes exactly; the orchestrator itself, unprobed", async () => {
  const { health, calls } = harness({
    broker: ok(NOW - 2 * 86_400_000),
    runner: ok(NOW - 60_000, { active: true }),
    models: ok(NOW - STARTING_MS),
    github: ok(NOW - STARTING_MS + 1, { app: true }),
  });
  const { checkedAt, services } = await health.check();
  assert.equal(checkedAt, NOW);
  const s = byName(services);
  assert.deepEqual(s.broker, {
    name: "broker",
    state: "up",
    startedAt: NOW - 2 * 86_400_000,
    version: "1.4.0",
    checkedAt: NOW,
  });
  assert.equal(s.runner.state, "starting");
  assert.equal(s.models.state, "up");
  assert.equal(s.github.state, "starting");
  assert.deepEqual(s.orchestrator, {
    name: "orchestrator",
    state: "up",
    startedAt: NOW - 3_600_000,
    version: "1.4.0",
    checkedAt: NOW,
  });
  // In the services' order, the orchestrator never called.
  assert.deepEqual(
    services.map((x) => x.name),
    ["orchestrator", "runner", "broker", "github", "models"],
  );
  assert.ok(calls.every((url) => url.endsWith("/health")));
  assert.equal(calls.length, 4);
});

test("down: a timeout, a refused connection, a 503, ok false; the reason never its URL or body", async () => {
  const { health } = harness(
    {
      // What fetch throws once its signal times out (the next test waits for one).
      broker: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      runner: refused(),
      github: new Response("secret detail http://github:8080", { status: 503 }),
      models: Response.json({ ok: false, startedAt: NOW, version: "1.4.0" }),
      policy: new Response("ok\n"),
    },
    {},
  );
  const s = byName((await health.check()).services);
  assert.deepEqual(s.broker, {
    name: "broker",
    state: "down",
    startedAt: null,
    version: null,
    checkedAt: NOW,
    reason: "timeout",
  });
  assert.equal(s.runner.reason, "refused");
  assert.equal(s.github.reason, "HTTP 503");
  assert.equal(s.models.reason, "not ok");
  // The policy service's plain text from before #560.
  assert.equal(s.policy.reason, "not JSON");
  for (const name of ["broker", "runner", "github", "models", "policy"]) {
    assert.equal(s[name].state, "down", name);
  }
  assert.doesNotMatch(JSON.stringify(s), /http:|secret|:8080/);
});

test("a timeout: a service that doesn't answer within its limit, for real", async (t) => {
  const health = createHealth({
    urls: { broker: "http://broker:8081" },
    self: { name: "orchestrator", startedAt: 0, version: "dev" },
    timeoutMs: 20,
    fetch: (url, init) =>
      new Promise((resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      ),
  });
  const [broker] = (await health.check()).services.filter((s) => s.name === "broker");
  assert.equal(broker.reason, "timeout");
});

test("a refused connection, through the real fetch", async () => {
  const port = await closedPort();
  const health = createHealth({
    urls: { policy: `http://127.0.0.1:${port}` },
    self: { name: "orchestrator", startedAt: 0, version: "dev" },
  });
  const policy = (await health.check()).services.find((s) => s.name === "policy");
  assert.equal(policy.state, "down");
  assert.equal(policy.reason, "refused");
});

test("a service with no URL is left out; several copies: the first that answers", async () => {
  const { health, calls } = harness(
    { a: refused(), b: ok(NOW - 86_400_000) },
    { urls: { broker: "http://a:8081,http://b:8081", models: "", proxy: null } },
  );
  const { services } = await health.check();
  assert.deepEqual(
    services.map((s) => [s.name, s.state]),
    [
      ["orchestrator", "up"],
      ["broker", "up"],
    ],
  );
  assert.deepEqual(calls, ["http://a:8081/health", "http://b:8081/health"]);
});

test("an answer without a start (a copy from before #560) is up", async () => {
  const { health } = harness({ runner: Response.json({ ok: true, active: true }) });
  const runner = (await health.check()).services.find((s) => s.name === "runner");
  assert.equal(runner.state, "up");
  assert.equal(runner.startedAt, null);
});

test("the cache: two calls within 10 s probe once, the next one after", async () => {
  let probes = 0;
  const { health, clock } = harness({ broker: () => (probes++, ok(NOW - 86_400_000)) });
  const [first, second] = await Promise.all([health.check(), health.check()]);
  clock.now += CACHE_MS - 1;
  const third = await health.check();
  assert.equal(probes, 1);
  assert.equal(first, second);
  assert.equal(third, first);
  clock.now += 1;
  const fourth = await health.check();
  assert.equal(probes, 2);
  assert.equal(fourth.checkedAt, NOW + CACHE_MS);
});

test("reasonOf: a word, whatever fetch says", () => {
  assert.equal(reasonOf(new DOMException("x", "TimeoutError")), "timeout");
  assert.equal(reasonOf({ cause: { code: "ENOTFOUND" } }), "unknown host");
  assert.equal(reasonOf({ cause: { code: "ECONNRESET" } }), "reset");
  assert.equal(reasonOf(new Error("http://secret:1 failed")), "unreachable");
});
