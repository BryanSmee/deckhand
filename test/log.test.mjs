// The services' own log lines (lib/log.mjs, #547): JSON or text, levels, redaction, and the
// request, repository, issue and run they belong to.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  deliveryContext,
  logContext,
  REQUEST_HEADER,
  requestHeaders,
  withLogContext,
  withRequest,
} from "../lib/log.mjs";
import { REDACTED } from "../lib/redact.mjs";

const NOW = () => new Date("2026-11-02T10:00:00.000Z");

// A logger writing to a list. → { log, lines }.
function logger(env = {}, extra = {}) {
  const lines = [];
  const log = createLogger({
    service: "runner",
    env,
    now: NOW,
    write: (l) => lines.push(l),
    ...extra,
  });
  return { log, lines };
}

const GITHUB_TOKEN = `ghs_${"a1B2".repeat(9)}`;

test("JSON when LOG_FORMAT is unset: one object a line, its time, level, service and message", () => {
  const { log, lines } = logger();
  log.info("Runner on :8080", { port: 8080 });
  log.error("It failed");
  assert.deepEqual(JSON.parse(lines[0]), {
    ts: "2026-11-02T10:00:00.000Z",
    level: "info",
    service: "runner",
    msg: "Runner on :8080",
    port: 8080,
  });
  assert.equal(JSON.parse(lines[1]).level, "error");
  assert.equal(lines.length, 2);
  // A field never overwrites the line's own keys.
  log.warn("Odd", { level: "debug", service: "edge", msg: "other", ts: 0 });
  const odd = JSON.parse(lines[2]);
  assert.deepEqual(
    [odd.level, odd.service, odd.msg, odd.ts],
    ["warn", "runner", "Odd", NOW().toISOString()],
  );
});

test("log(...args), as the modules call the injected log: info, its arguments as console.log joins them", () => {
  const { log, lines } = logger();
  log("Delivery", 42, "ignored");
  assert.equal(JSON.parse(lines[0]).msg, "Delivery 42 ignored");
  assert.equal(JSON.parse(lines[0]).level, "info");
});

test("LOG_LEVEL: lines below it are left out; info by default; an unknown one said, info used", () => {
  const all = logger({ LOG_LEVEL: "debug" });
  for (const level of ["debug", "info", "warn", "error"]) all.log[level](level);
  assert.deepEqual(
    all.lines.map((l) => JSON.parse(l).level),
    ["debug", "info", "warn", "error"],
  );
  const plain = logger();
  plain.log.debug("hidden");
  plain.log.info("shown");
  assert.deepEqual(
    plain.lines.map((l) => JSON.parse(l).msg),
    ["shown"],
  );
  const errors = logger({ LOG_LEVEL: "ERROR" });
  errors.log.warn("hidden");
  errors.log("hidden too");
  errors.log.error("shown");
  assert.deepEqual(
    errors.lines.map((l) => JSON.parse(l).msg),
    ["shown"],
  );
  const unknown = logger({ LOG_LEVEL: "loud" });
  unknown.log.debug("hidden");
  unknown.log.info("shown");
  assert.deepEqual(
    unknown.lines.map((l) => JSON.parse(l).msg),
    ["LOG_LEVEL: loud unknown, info used", "shown"],
  );
});

test("text: the time and message, the level when not info, then the context and the fields", () => {
  const { log, lines } = logger({ LOG_FORMAT: "text" });
  log("Runner on :8080");
  log.warn("Slow", { ms: 1200, why: "a long pull" });
  withLogContext({ request: "abc123", repo: "o/a", issue: 7, run: "dh-o-a-7-1" }, () =>
    log.error("Not started", { reason: "" }),
  );
  assert.deepEqual(lines, [
    "2026-11-02T10:00:00.000Z Runner on :8080",
    '2026-11-02T10:00:00.000Z WARN Slow ms=1200 why="a long pull"',
    '2026-11-02T10:00:00.000Z ERROR Not started request=abc123 repo=o/a issue=7 run=dh-o-a-7-1 reason=""',
  ]);
  // An unknown format is said, and JSON used.
  const other = logger({ LOG_FORMAT: "xml" });
  assert.equal(JSON.parse(other.lines[0]).msg, "LOG_FORMAT: xml unknown, json used");
});

test("every line redacted: GitHub's tokens, the service's own secrets, in both formats", () => {
  const secret = "s3cr3t-session-key-0123456789";
  for (const LOG_FORMAT of ["json", "text"]) {
    const { log, lines } = logger({ LOG_FORMAT }, { secrets: () => [secret] });
    log(`Token ${GITHUB_TOKEN} and key ${secret}`);
    log.error("Failed", { error: new Error(`with ${secret}`), nested: { list: [GITHUB_TOKEN] } });
    const all = lines.join("\n");
    assert.ok(!all.includes(GITHUB_TOKEN), LOG_FORMAT);
    assert.ok(!all.includes(secret.slice(0, 16)), LOG_FORMAT);
    assert.ok(all.includes(REDACTED), LOG_FORMAT);
    if (LOG_FORMAT === "json") {
      const line = JSON.parse(lines[1]);
      assert.match(line.error, /^Error: with \[redacted\]\n/);
      assert.deepEqual(line.nested, { list: [REDACTED] });
    }
  }
  // Secrets that can't be read yet (a service still starting): the token shapes still go.
  const { log, lines } = logger(
    {},
    {
      secrets: () => {
        throw new Error("not yet");
      },
    },
  );
  log(GITHUB_TOKEN);
  assert.equal(JSON.parse(lines[0]).msg, REDACTED);
});

test("the context: on every line in it, through awaits; nested ones add to it", async () => {
  const { log, lines } = logger();
  assert.deepEqual(requestHeaders(), {});
  await withLogContext({ request: "r1", repo: "o/a", issue: null }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    log("one");
    assert.deepEqual(requestHeaders(), { [REQUEST_HEADER]: "r1" });
    await withLogContext({ run: "dh-o-a-1-1", issue: 1 }, async () => log("two"));
  });
  log("out");
  const [one, two, out] = lines.map((l) => JSON.parse(l));
  assert.deepEqual(
    [one.request, one.repo, one.issue, one.run],
    ["r1", "o/a", undefined, undefined],
  );
  assert.deepEqual([two.request, two.repo, two.issue, two.run], ["r1", "o/a", 1, "dh-o-a-1-1"]);
  assert.equal(out.request, undefined);
});

test("withRequest: the caller's ID taken when it looks like one; edge's public port always a new one", async () => {
  const seen = [];
  const handler = () => seen.push(logContext().request);
  const req = (id) => ({ headers: id === undefined ? {} : { [REQUEST_HEADER]: id } });
  withRequest(handler)(req("4f1c2a9e0b7d6e35"), {});
  withRequest(handler)(req(), {});
  withRequest(handler)(req("not one; of ours"), {});
  withRequest(handler)(req("x".repeat(65)), {});
  withRequest(handler, { trusted: false })(req("chosen-by-the-internet"), {});
  assert.equal(seen[0], "4f1c2a9e0b7d6e35");
  for (const id of seen.slice(1)) assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(new Set(seen).size, seen.length);
});

test("deliveryContext: edge's request ID, the repository and the issue, pull request or discussion", () => {
  const repository = { full_name: "o/a" };
  assert.deepEqual(
    deliveryContext({ request: "r1", payload: { repository, issue: { number: 3 } } }),
    { request: "r1", repo: "o/a", issue: 3 },
  );
  assert.equal(deliveryContext({ payload: { pull_request: { number: 5 } } }).issue, 5);
  assert.equal(deliveryContext({ payload: { discussion: { number: 9 } } }).issue, 9);
  // An entry from before it carried one, or a broken one: a new ID, nothing else.
  const old = deliveryContext({ request: "a b", payload: null });
  assert.match(old.request, /^[0-9a-f]{16}$/);
  assert.deepEqual([old.repo, old.issue], [null, null]);
  assert.match(deliveryContext(undefined).request, /^[0-9a-f]{16}$/);
});
