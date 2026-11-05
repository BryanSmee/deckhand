// GitHub's own status (#681, ../github/status.mjs): githubstatus.com's summary read and kept, each
// indicator as it says it, the components Deckhand depends on when they aren't operational, the
// open incidents with their pages; a failed read keeps the last one, with its time.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPONENTS,
  createGithubStatus,
  INCIDENT_URL,
  SUMMARY_URL,
  summarize,
} from "../github/status.mjs";

const DESCRIPTIONS = {
  none: "All Systems Operational",
  minor: "Minor Service Outage",
  major: "Partial System Outage",
  critical: "Major System Outage",
};

// A summary as githubstatus.com writes it.
const summary = (indicator, { components = [], incidents = [] } = {}) => ({
  page: { id: "kctbh9vrtdwd", name: "GitHub", url: "https://www.githubstatus.com" },
  status: { indicator, description: DESCRIPTIONS[indicator] ?? "Under maintenance" },
  components: [
    ...COMPONENTS.map((name) => ({ id: name, name, status: "operational" })),
    { id: "copilot", name: "Copilot", status: "major_outage" },
  ].map((c) => components.find((d) => d.name === c.name) ?? c),
  incidents,
  scheduled_maintenances: [],
});

// A status read through a fake fetch: `answers` in turn (a value is its JSON, an Error thrown,
// a number that status), and a clock the test moves.
function reading(answers) {
  const clock = { at: 1_000 };
  const asked = [];
  const status = createGithubStatus({
    fetch: async (url, init) => {
      asked.push({ url, init });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "number") return new Response("oops", { status: next });
      if (typeof next === "string") return new Response(next);
      return Response.json(next);
    },
    now: () => clock.at,
  });
  return { status, clock, asked };
}

for (const indicator of ["none", "minor", "major", "critical"]) {
  test(`a summary whose indicator is ${indicator}: said as it is`, async () => {
    const { status, asked } = reading([summary(indicator)]);
    await status.check();
    assert.equal(asked[0].url, SUMMARY_URL);
    const current = status.current();
    assert.deepEqual(
      [current.watched, current.indicator, current.description, current.failed],
      [true, indicator, DESCRIPTIONS[indicator], null],
    );
    assert.deepEqual([current.checkedAt, current.triedAt], [1_000, 1_000]);
    // Copilot's outage isn't one Deckhand depends on.
    assert.deepEqual(current.components, []);
  });
}

test("the components Deckhand depends on, when they aren't operational, and the open incidents", () => {
  const said = summarize(
    summary("major", {
      components: [
        { name: "Webhooks", status: "degraded_performance" },
        { name: "Git Operations", status: "partial_outage" },
      ],
      incidents: [
        {
          id: "x8wr3gq6l9fd",
          name: "Disruption with some GitHub services",
          status: "investigating",
          impact: "major",
          created_at: "2026-11-05T09:58:00.000Z",
          started_at: "2026-11-05T09:55:00.000Z",
          shortlink: "https://stspg.io/abc",
        },
        // Its id isn't one: no link made of it.
        { id: "../../evil", name: "Odd", status: "identified", created_at: "2026-11-05T10:00Z" },
        { id: "done1", name: "Over", status: "resolved" },
      ],
    }),
  );
  assert.deepEqual(said.components, [
    { name: "Webhooks", status: "degraded_performance" },
    { name: "Git Operations", status: "partial_outage" },
  ]);
  assert.deepEqual(said.incidents, [
    {
      name: "Disruption with some GitHub services",
      status: "investigating",
      impact: "major",
      startedAt: Date.parse("2026-11-05T09:55:00.000Z"),
      url: `${INCIDENT_URL}x8wr3gq6l9fd`,
    },
    {
      name: "Odd",
      status: "identified",
      impact: null,
      startedAt: Date.parse("2026-11-05T10:00Z"),
      url: null,
    },
  ]);
});

test("a failed read keeps the last summary, with when it was read and why the next one failed", async () => {
  const answers = [summary("minor"), 503, new Error("getaddrinfo ENOTFOUND"), "<html>", null];
  const { status, clock } = reading(answers);
  await status.check();
  for (const error of ["HTTP 503", "getaddrinfo ENOTFOUND", "not JSON"]) {
    clock.at += 300_000;
    await status.check();
    const current = status.current();
    assert.deepEqual(
      [current.indicator, current.description, current.checkedAt, current.triedAt, current.failed],
      ["minor", DESCRIPTIONS.minor, 1_000, clock.at, error],
    );
  }
  // JSON that isn't a summary: the same.
  clock.at += 300_000;
  await status.check();
  assert.deepEqual(
    [status.current().indicator, status.current().failed],
    ["minor", "not GitHub's status summary"],
  );
});

test("before any summary is read, nothing is said of GitHub; off github.com, nothing is read", async () => {
  const { status } = reading([500]);
  await status.check();
  assert.deepEqual(status.current(), {
    watched: true,
    checkedAt: null,
    triedAt: 1_000,
    failed: "HTTP 500",
    indicator: null,
    description: "",
    components: [],
    incidents: [],
  });
  let asked = 0;
  const off = createGithubStatus({
    watched: false,
    fetch: async () => (asked++, Response.json({})),
  });
  await off.start();
  off.stop();
  assert.deepEqual([off.current(), asked], [{ watched: false }, 0]);
});

test("read at start, then every interval until stopped", async () => {
  const timers = [];
  let asked = 0;
  const status = createGithubStatus({
    intervalMs: 60_000,
    fetch: async () => (asked++, Response.json(summary("none"))),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => (timer.cleared = true),
  });
  await status.start();
  // Its next read scheduled once the first is over.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([asked, timers.length, timers[0].ms], [1, 1, 60_000]);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([asked, timers.length], [2, 2]);
  status.stop();
  assert.equal(timers[1].cleared, true);
});
