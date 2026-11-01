// The plans' usage (#486): parsed from the plans' answers and usage calls, kept for every copy,
// read by the dashboard through the orchestrator.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../lib/store.mjs";
import { planOf } from "../listener/models-service.mjs";
import { createAnthropicProxy } from "../models/anthropic.mjs";
import { createOpenAiProxy } from "../models/openai.mjs";
import {
  antigravityPoll,
  antigravityPolled,
  claudePoll,
  codexPoll,
  claudePolled,
  claudeWindows,
  codexPolled,
  codexWindows,
  createUsage,
  FAILED_MS,
  POLL_MS,
  REFRESH_EVERY_MS,
} from "../models/usage.mjs";
import { serve, tokenBroker } from "./helpers.mjs";

const NOW = 1_800_000_000_000;

// A Claude plan's answer, as recorded (Claude Code 2.x's calls, Max plan).
const CLAUDE_HEADERS = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1800003600",
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1800300000",
  "anthropic-ratelimit-unified-7d-utilization": "0.18",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-reset": "1800003600",
  "request-id": "req_011CU",
};

// A ChatGPT plan's answer, as Codex reads it.
const CODEX_HEADERS = {
  "x-codex-primary-used-percent": "37.5",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1800004000",
  "x-codex-secondary-used-percent": "9",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-after-seconds": "86400",
  "x-request-id": "req_1",
};

test("a Claude plan's headers: its 5-hour and weekly windows, as fractions with their resets", () => {
  assert.deepEqual(claudeWindows(CLAUDE_HEADERS), [
    { name: "5h", used: 0.42, resetsAt: 1_800_003_600_000 },
    { name: "7d", used: 0.18, resetsAt: 1_800_300_000_000 },
  ]);
});

test("missing or garbled headers leave their window out, never a made-up value", () => {
  assert.deepEqual(claudeWindows({}), []);
  assert.deepEqual(
    claudeWindows({
      "anthropic-ratelimit-unified-5h-utilization": "lots",
      "anthropic-ratelimit-unified-7d-utilization": "-1",
      "anthropic-ratelimit-unified-7d_opus-utilization": "0.9",
      "anthropic-ratelimit-unified-7d_opus-reset": "soon",
    }),
    [{ name: "7d_opus", used: 0.9, resetsAt: null }],
  );
  // Over the limit reads as full.
  assert.equal(claudeWindows({ "anthropic-ratelimit-unified-5h-utilization": "1.3" })[0].used, 1);
  assert.deepEqual(codexWindows({ "x-codex-primary-used-percent": "" }), []);
});

test("a ChatGPT plan's headers: windows named by their length, resets at or after", () => {
  assert.deepEqual(codexWindows(CODEX_HEADERS, NOW), [
    { name: "5h", used: 0.375, resetsAt: 1_800_004_000_000 },
    { name: "7d", used: 0.09, resetsAt: NOW + 86_400_000 },
  ]);
  // No length: by which window it is.
  assert.deepEqual(codexWindows({ "x-codex-primary-used-percent": "50" }, NOW), [
    { name: "primary", used: 0.5, resetsAt: null },
  ]);
});

test("the plans' usage calls: Claude's, ChatGPT's and the Antigravity CLI's answers", () => {
  assert.deepEqual(
    claudePolled({
      five_hour: { utilization: 42, resets_at: "2027-01-15T13:10:00.000+00:00" },
      seven_day: { utilization: 18.5, resets_at: null },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    }),
    [
      { name: "5h", used: 0.42, resetsAt: Date.parse("2027-01-15T13:10:00Z") },
      { name: "7d", used: 0.185, resetsAt: null },
    ],
  );
  assert.deepEqual(claudePolled(null), []);
  assert.deepEqual(
    codexPolled(
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1800001000 },
          secondary_window: {
            used_percent: 3,
            limit_window_seconds: 604800,
            reset_after_seconds: 60,
          },
        },
      },
      NOW,
    ),
    [
      { name: "5h", used: 0.12, resetsAt: 1_800_001_000_000 },
      { name: "7d", used: 0.03, resetsAt: NOW + 60_000 },
    ],
  );
  assert.deepEqual(
    antigravityPolled({
      models: {
        "gemini-3-pro": {
          displayName: "Gemini 3 Pro",
          quotaInfo: { remainingFraction: 0.75, resetTime: "2027-01-15T13:00:00Z" },
        },
        "gemini-3-pro-low": {
          displayName: "Gemini 3 Pro (Low)",
          quotaInfo: { remainingFraction: 0.75, resetTime: "2027-01-15T13:00:00Z" },
        },
        // Spent: proto3's JSON leaves the zero out.
        "claude-sonnet": {
          displayName: "Claude Sonnet",
          quotaInfo: { resetTime: "2027-01-15T14:00:00Z" },
        },
        "no-quota": { displayName: "Tab" },
      },
    }),
    [
      {
        name: "claude-sonnet",
        label: "Claude Sonnet",
        used: 1,
        resetsAt: Date.parse("2027-01-15T14:00:00Z"),
      },
      {
        name: "gemini-3-pro",
        label: "Gemini 3 Pro",
        used: 0.25,
        resetsAt: Date.parse("2027-01-15T13:00:00Z"),
      },
    ],
  );
});

function usageOf(plans, clock = { now: NOW }, logs = []) {
  const store = openStore("memory:", { now: () => clock.now });
  return {
    usage: createUsage({ plans, store, now: () => clock.now, log: (l) => logs.push(l) }),
    store,
    clock,
    logs,
  };
}

test("no plan set: nothing to read; a plan set without readings: no windows yet", async () => {
  assert.deepEqual(await usageOf({}).usage.read(), []);
  const { usage } = usageOf({ claude: true });
  await usage.claudeAnswered(200, CLAUDE_HEADERS, null);
  const { usage: none } = usageOf({ codex: true });
  await none.claudeAnswered(200, CLAUDE_HEADERS, null);
  assert.deepEqual(await none.read(), [
    {
      plan: "codex",
      label: "Codex",
      windows: [],
      updatedAt: null,
      limited: false,
      limitedUntil: null,
    },
  ]);
  const [claude] = await usage.read();
  assert.equal(claude.updatedAt, NOW);
  assert.deepEqual(
    claude.windows.map((w) => [w.name, w.used, w.at]),
    [
      ["5h", 0.42, NOW],
      ["7d", 0.18, NOW],
    ],
  );
});

test("a plan's 429 marks its window full until the reset; past it, the plan isn't limited", async () => {
  const { usage, clock } = usageOf({ claude: true });
  await usage.claudeAnswered(200, CLAUDE_HEADERS, null);
  const reset = 1_800_300_000_000;
  await usage.claudeAnswered(
    429,
    {
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-reset": "1800300000",
    },
    reset,
  );
  let [claude] = await usage.read();
  assert.equal(claude.limited, true);
  assert.equal(claude.limitedUntil, reset);
  assert.deepEqual(
    claude.windows.map((w) => [w.name, w.used]),
    [
      ["5h", 0.42],
      ["7d", 1],
    ],
  );
  // Past the reset, no longer limited.
  clock.now = reset + 1;
  [claude] = await usage.read();
  assert.equal(claude.limited, false);
  assert.equal(claude.limitedUntil, null);
  // An answer that gets through clears the limit at once, too.
  clock.now = NOW;
  await usage.claudeAnswered(200, CLAUDE_HEADERS, null);
  [claude] = await usage.read();
  assert.equal(claude.limited, false);
});

test("a ChatGPT plan's 429: limited until the spent window resets", async () => {
  const { usage } = usageOf({ codex: true });
  await usage.codexAnswered(429, { ...CODEX_HEADERS, "x-codex-primary-used-percent": "100" });
  const [codex] = await usage.read();
  assert.equal(codex.limited, true);
  assert.equal(codex.limitedUntil, 1_800_004_000_000);
});

test("readings are merged by window, and written only when they change or a minute on", async () => {
  const { usage, store, clock } = usageOf({ claude: true });
  await usage.seen("claude", [{ name: "7d_opus", used: 0.5, resetsAt: NOW + 3600_000 }]);
  await usage.claudeAnswered(200, CLAUDE_HEADERS, null);
  const names = (await usage.read())[0].windows.map((w) => w.name);
  assert.deepEqual(names, ["5h", "7d", "7d_opus"]);
  let writes = 0;
  const set = store.compareAndSet.bind(store);
  store.compareAndSet = (...args) => (writes++, set(...args));
  clock.now += 1000;
  await usage.claudeAnswered(200, CLAUDE_HEADERS, null);
  assert.equal(writes, 0);
  clock.now += 60_000;
  await usage.claudeAnswered(200, CLAUDE_HEADERS, null);
  assert.equal(writes, 1);
});

test("a dashboard's poll asks a plan not read lately, once for every copy, and a failure waits", async () => {
  const clock = { now: NOW };
  const store = openStore("memory:", { now: () => clock.now });
  const asked = [];
  let fail = false;
  const ask = async () => {
    asked.push(clock.now);
    if (fail) throw new Error("answered 403");
    return [{ name: "5h", used: 0.3, resetsAt: NOW + 3600_000 }];
  };
  const logs = [];
  const copies = [0, 1].map(() =>
    createUsage({ plans: { claude: ask }, store, now: () => clock.now, log: (l) => logs.push(l) }),
  );
  // No dashboard: no poll.
  await copies[0].read();
  assert.equal(asked.length, 0);
  await copies[0].read({ poll: true });
  await copies[0].settled();
  await copies[1].read({ poll: true });
  await copies[1].settled();
  assert.equal(asked.length, 1);
  assert.equal((await copies[1].read())[0].windows[0].used, 0.3);
  // Read lately: not asked again until POLL_MS on.
  clock.now += POLL_MS - 1;
  await copies[1].read({ poll: true });
  await copies[1].settled();
  assert.equal(asked.length, 1);
  // Failing: logged, the reading kept, and not asked again before FAILED_MS.
  fail = true;
  clock.now += 2;
  await copies[1].read({ poll: true });
  await copies[1].settled();
  assert.equal(asked.length, 2);
  assert.match(logs.at(-1), /Claude's usage call failed \(answered 403\)/);
  assert.equal((await copies[0].read())[0].windows[0].used, 0.3);
  clock.now += POLL_MS + 1;
  await copies[0].read({ poll: true });
  await copies[0].settled();
  assert.equal(asked.length, 2);
  clock.now += FAILED_MS;
  fail = false;
  await copies[0].read({ poll: true });
  await copies[0].settled();
  assert.equal(asked.length, 3);
});

// Claude's endpoint with a plan and an API key, answering with the plan's headers.
async function serveClaude(t, usage, { name = "CLAUDE_CODE_OAUTH_TOKEN" } = {}) {
  const { url: upstream } = await serve(t, (req, res) => {
    req.resume().on("end", () => {
      res.writeHead(200, CLAUDE_HEADERS);
      res.end("{}");
    });
  });
  const broker = tokenBroker();
  const proxy = createAnthropicProxy({
    runs: broker,
    name,
    credential: name === "CLAUDE_CODE_OAUTH_TOKEN" ? "sk-ant-oat01-plan" : "sk-gateway",
    named: { plan: "sk-ant-oat01-plan", key: "sk-ant-api03-key" },
    upstream,
    providers: {
      openrouter: { name: "OPENROUTER_API_KEY", credential: "sk-or-v1-x", upstream },
    },
    usage,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const call = async (provider, credential, header) => {
    const id = broker.register("org/repo");
    broker.provide(id, provider, null, credential);
    const token = broker.agentToken(id);
    const res = await fetch(`${url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { [header]: header === "x-api-key" ? token : `Bearer ${token}` },
      body: "{}",
    });
    await res.text();
    await usage.settled();
  };
  return { call };
}

test("only runs on the plan feed it: not the API key, a gateway or OpenRouter", async (t) => {
  const { usage } = usageOf({ claude: true });
  const { call } = await serveClaude(t, usage);
  await call("anthropic", "key", "x-api-key");
  await call("openrouter", null, "authorization");
  // A gateway's token (ANTHROPIC_AUTH_TOKEN) as the default credential.
  const gateway = await serveClaude(t, usage, { name: "ANTHROPIC_AUTH_TOKEN" });
  await gateway.call("anthropic", null, "authorization");
  assert.deepEqual((await usage.read())[0].windows, []);
  await call("anthropic", null, "authorization");
  const [claude] = await usage.read();
  assert.deepEqual(
    claude.windows.map((w) => w.used),
    [0.42, 0.18],
  );
  // Nothing but the parsed numbers and times: no header's value, no credential.
  const text = JSON.stringify(await usage.read());
  for (const value of ["sk-ant", "req_011CU", "allowed", "five_hour", "0.5"]) {
    assert.ok(!text.includes(value), value);
  }
});

test("a Codex run on a ChatGPT plan feeds the Codex entry; on an API key, nothing", async (t) => {
  const { url: upstream } = await serve(t, (req, res) => {
    req.resume().on("end", () => {
      res.writeHead(200, CODEX_HEADERS);
      res.end("{}");
    });
  });
  const run = async (proxy, usage) => {
    const broker = tokenBroker();
    proxy = proxy(broker);
    const { url } = await serve(t, (req, res) => proxy.handle(req, res));
    const id = broker.register("org/repo");
    broker.provide(id, "openai");
    const res = await fetch(`${url}/openai/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${broker.agentToken(id)}` },
      body: "{}",
    });
    await res.text();
    await usage.settled();
    return (await usage.read())[0].windows;
  };
  const onKey = usageOf({ codex: true }).usage;
  const keyWindows = await run(
    (runs) => createOpenAiProxy({ runs, credential: "sk-proj", upstream, usage: onKey }),
    onKey,
  );
  assert.deepEqual(keyWindows, []);
  const onPlan = usageOf({ codex: true }).usage;
  const login = {
    headers: async () => ({ authorization: "Bearer plan-access" }),
    refused: () => {},
    secrets: () => [],
  };
  const planWindows = await run(
    (runs) => createOpenAiProxy({ runs, login, chatgptUrl: `${upstream}/codex`, usage: onPlan }),
    onPlan,
  );
  assert.deepEqual(
    planWindows.map((w) => [w.name, w.used]),
    [
      ["5h", 0.375],
      ["7d", 0.09],
    ],
  );
});

test("the orchestrator keeps of a plan's usage its numbers, times and names only", () => {
  assert.deepEqual(
    planOf({
      plan: "claude",
      label: "Claude",
      windows: [
        { name: "5h", used: 2, resetsAt: 1, at: 2, token: "sk-ant-oat01" },
        { name: "7d", used: "0.5" },
      ],
      updatedAt: 2,
      limited: "yes",
      header: "x",
    }),
    {
      plan: "claude",
      label: "Claude",
      windows: [{ name: "5h", used: 1, resetsAt: 1, at: 2 }],
      updatedAt: 2,
      limited: false,
      limitedUntil: null,
    },
  );
  assert.equal(planOf(null), null);
});

test("Claude's usage call refused to a setup-token's token: logged once, never asked again", async (t) => {
  const asked = [];
  const { url } = await serve(t, (req, res) => {
    asked.push(req.url);
    res.writeHead(403, { "content-type": "application/json" });
    res.end('{"error":{"message":"OAuth token does not meet scope requirement user:profile"}}');
  });
  const clock = { now: NOW };
  const logs = [];
  const { usage } = usageOf(
    { claude: claudePoll({ token: "sk-ant-oat01-x", upstream: url, fetch }) },
    clock,
    logs,
  );
  for (let i = 0; i < 3; i++) {
    await usage.read({ poll: true });
    await usage.settled();
    clock.now += FAILED_MS + POLL_MS;
  }
  assert.deepEqual(asked, ["/api/oauth/usage"]);
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /Claude's usage call refused \(answered 403: .*user:profile.*\): not asked again/,
  );
  assert.ok(!logs[0].includes("sk-ant"));
});

test("a ChatGPT login due for a refresh isn't polled; the Antigravity CLI's is refreshed, once an hour", async (t) => {
  const asked = [];
  const { url } = await serve(t, (req, res) => {
    asked.push(req.url);
    res.end(JSON.stringify({ rate_limit: {}, models: {} }));
  });
  // Two logins, each due until refreshed (its headers() called).
  const loginOf = () => {
    const login = { refreshed: 0, fresh: false };
    login.current = async () => (login.fresh ? { authorization: "Bearer a" } : null);
    login.headers = async () => (
      login.refreshed++,
      (login.fresh = true),
      { authorization: "Bearer a" }
    );
    return login;
  };
  const chatgpt = loginOf();
  const agy = loginOf();
  const clock = { now: NOW };
  const store = openStore("memory:", { now: () => clock.now });
  const copies = [0, 1].map(() =>
    createUsage({
      plans: {
        codex: codexPoll({ login: chatgpt, chatgptUrl: `${url}/backend-api/codex`, fetch }),
        antigravity: antigravityPoll({ login: agy, host: url, fetch }),
      },
      store,
      now: () => clock.now,
    }),
  );
  const poll = async (copy) => {
    await copy.read({ poll: true });
    await copy.settled();
  };
  await poll(copies[0]);
  // ChatGPT's: not polled, not refreshed. The Antigravity CLI's: refreshed, then polled.
  assert.equal(chatgpt.refreshed, 0);
  assert.equal(agy.refreshed, 1);
  assert.deepEqual(asked.sort(), [
    "/v1internal:fetchAvailableModels",
    "/v1internal:loadCodeAssist",
  ]);
  // Due again before the hour is out: no refresh, by either copy, so no poll.
  agy.fresh = false;
  asked.length = 0;
  clock.now += 10 * 60_000;
  await poll(copies[1]);
  clock.now += 10 * 60_000;
  await poll(copies[0]);
  assert.equal(agy.refreshed, 1);
  assert.deepEqual(asked, []);
  // An hour on: refreshed again.
  clock.now += REFRESH_EVERY_MS;
  await poll(copies[1]);
  assert.equal(agy.refreshed, 2);
  assert.ok(asked.includes("/v1internal:fetchAvailableModels"));
  // A run refreshed the ChatGPT login: polled, never refreshed by the poll.
  chatgpt.fresh = true;
  clock.now += POLL_MS;
  await poll(copies[0]);
  assert.ok(asked.includes("/backend-api/wham/usage"));
  assert.equal(chatgpt.refreshed, 0);
});

test("Codex's resets given as seconds after the answer: not a write at each answer", async () => {
  const { usage, store, clock } = usageOf({ codex: true });
  const headers = {
    "x-codex-primary-used-percent": "40",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "3600",
  };
  await usage.codexAnswered(200, headers);
  let writes = 0;
  const cas = store.compareAndSet.bind(store);
  store.compareAndSet = (...args) => (writes++, cas(...args));
  // The same reset, seconds on: the same minute.
  clock.now += 2000;
  await usage.codexAnswered(200, { ...headers, "x-codex-primary-reset-after-seconds": "3598" });
  clock.now += 1500;
  await usage.codexAnswered(200, headers);
  assert.equal(writes, 0);
  // A percent more: written.
  await usage.codexAnswered(200, { ...headers, "x-codex-primary-used-percent": "41" });
  assert.equal(writes, 1);
});

test("a usage call's reading replaces the plan's windows; the runs' answers merge, in one order", async () => {
  const { usage } = usageOf({ antigravity: true, claude: true });
  const w = (name, used) => ({ name, used, resetsAt: NOW + 3600_000 });
  await usage.seen("antigravity", [w("gemini-pro", 0.5), w("claude-sonnet", 0.2)], {
    polled: true,
  });
  // The next call folds claude-sonnet into gemini-pro's quota: its old window goes.
  await usage.seen("antigravity", [w("gemini-pro", 0.6)], { polled: true });
  const read = async (plan) =>
    (await usage.read()).find((p) => p.plan === plan).windows.map((x) => [x.name, x.used]);
  assert.deepEqual(await read("antigravity"), [["gemini-pro", 0.6]]);
  // Claude's: a model's window first in its reading, the main ones still first once merged.
  await usage.seen("claude", [w("7d_opus", 0.4)]);
  await usage.seen("claude", [w("7d", 0.3), w("5h", 0.1)]);
  assert.deepEqual(await read("claude"), [
    ["5h", 0.1],
    ["7d", 0.3],
    ["7d_opus", 0.4],
  ]);
});

test("two copies writing at once: neither loses the other's change, a 429's limit included", async () => {
  const clock = { now: NOW };
  const store = openStore("memory:", { now: () => clock.now });
  const [a, b] = [0, 1].map(() =>
    createUsage({ plans: { claude: true }, store, now: () => clock.now }),
  );
  // B reads the entry before A's write lands, then writes over it: compareAndSet sends it back.
  const get = store.get.bind(store);
  let racing = true;
  store.get = async (key) => {
    const value = await get(key);
    if (racing) {
      racing = false;
      await a.claudeAnswered(
        429,
        { "anthropic-ratelimit-unified-representative-claim": "five_hour" },
        NOW + 3600_000,
      );
    }
    return value;
  };
  await b.claudeAnswered(500, CLAUDE_HEADERS, null);
  const [claude] = await b.read();
  // A's limit kept; B's reading, the newer, over the windows.
  assert.equal(claude.limited, true);
  assert.equal(claude.limitedUntil, NOW + 3600_000);
  assert.deepEqual(
    claude.windows.map((w) => [w.name, w.used]),
    [
      ["5h", 0.42],
      ["7d", 0.18],
    ],
  );
});
