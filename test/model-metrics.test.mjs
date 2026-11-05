// The models service's metrics (models/metrics.mjs, #657): its agents' calls counted by status,
// length and the tokens their answers say, streams cut short, the plans' usage and the logins'
// refreshes.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import { createRegistry } from "../lib/metrics.mjs";
import { openStore } from "../lib/store.mjs";
import { loginSeal, LoginError, planLogin } from "../models/logins.mjs";
import {
  AGENTS,
  MAX_READ,
  modelMetrics,
  PROVIDERS,
  STATUSES,
  statusOf,
  usageReader,
} from "../models/metrics.mjs";
import { baseOf, createApiProxy } from "../models/upstream.mjs";
import { createUsage } from "../models/usage.mjs";
import { closedPort, serve, tempDir, tokenBroker } from "./helpers.mjs";

// `text`'s value of the sample `series` (`name{labels}`), or undefined.
const sample = (text, series) =>
  text
    .split("\n")
    .find((line) => line.startsWith(`${series} `))
    ?.split(" ")[1];

// `answer` read through usageReader(), in chunks of `size` bytes.
function read(contentType, answer, size = 7) {
  const reader = usageReader(contentType);
  const bytes = Buffer.from(answer);
  for (let i = 0; i < bytes.length; i += size) reader.write(bytes.subarray(i, i + size));
  return reader.end();
}

const sse = (...events) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("statusOf(): statusLabel()'s, unreachable when no answer came", () => {
  assert.equal(statusOf(200), "200");
  assert.equal(statusOf(418), "4xx");
  assert.equal(statusOf(429), "429");
  assert.equal(statusOf(505), "5xx");
  assert.equal(statusOf(529), "529");
  assert.equal(statusOf(502, { lost: true }), "unreachable");
  assert.equal(statusOf(999), "other");
});

test("usageReader(): Anthropic's stream, its message_start then message_delta's cumulative output", () => {
  const answer = sse(
    {
      type: "message_start",
      message: {
        content: [],
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 40,
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_delta", delta: { text: "héllo → wörld" } },
    { type: "message_delta", usage: { output_tokens: 15 } },
    { type: "message_delta", usage: { output_tokens: 30 } },
    { type: "message_stop" },
  );
  // Split anywhere, a multibyte character too.
  for (const size of [1, 3, 7, 4096]) {
    assert.deepEqual(read("text/event-stream; charset=utf-8", answer, size), {
      input: 12,
      output: 30,
      cache_read: 900,
      cache_write: 40,
    });
  }
  // A whole message (no stream), and a token count, which used nothing.
  assert.deepEqual(
    read(
      "application/json",
      JSON.stringify({ type: "message", usage: { input_tokens: 5, output_tokens: 7 } }),
    ),
    { input: 5, output: 7 },
  );
  assert.equal(read("application/json", JSON.stringify({ input_tokens: 5 })), null);
});

test("usageReader(): OpenAI's last event and Gemini's chunks, cached input apart from the rest", () => {
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 } };
  assert.deepEqual(
    read(
      "text/event-stream",
      sse(
        { type: "response.created", response: { usage: null } },
        { type: "response.completed", response: { usage: { ...usage, output_tokens: 50 } } },
      ),
    ),
    { input: 200, output: 50, cache_read: 800 },
  );
  // Gemini's stream (alt=sse) and the Cloud Code relay's: each chunk's usage the total so far.
  const chunk = (n) => ({
    usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: n },
  });
  assert.deepEqual(read("text/event-stream", sse(chunk(1), chunk(9))), {
    input: 40,
    output: 9,
    cache_read: 60,
  });
  assert.deepEqual(
    read(
      "text/event-stream",
      sse({ response: { usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 4 } } }),
    ),
    { input: 3, output: 4, cache_read: 0 },
  );
  // Without alt=sse: one JSON array, read whole.
  assert.deepEqual(read("application/json", JSON.stringify([chunk(1), chunk(5)])), {
    input: 40,
    output: 5,
    cache_read: 60,
  });
});

test(`usageReader(): a line or an answer past ${MAX_READ} bytes is left out, the rest read`, () => {
  const big = "x".repeat(MAX_READ + 10);
  const usage = { type: "message_delta", usage: { output_tokens: 3 } };
  assert.deepEqual(
    read("text/event-stream", `data: {"usage":"${big}"}\n\n${sse(usage)}`, 1 << 20),
    { output: 3 },
  );
  assert.equal(
    read("application/json", JSON.stringify({ ...usage, type: "message", big }), 1 << 20),
    null,
  );
  // Garbled lines, or no usage: nothing.
  assert.equal(read("text/event-stream", "data: {usage\n\ndata: [DONE]\n\n"), null);
});

// A provider answering each call as `answer(req, res)` says, through createApiProxy() counting
// in a registry of the test's.
async function counted(t, answer, options = {}) {
  const { url: upstream } = await serve(t, (req, res) => {
    req.resume();
    req.on("end", () => answer(req, res));
  });
  const registry = createRegistry();
  const metrics = modelMetrics(registry);
  const broker = tokenBroker();
  const proxy = createApiProxy({
    runs: broker,
    agent: "claude",
    metrics,
    pathRe: /^\/api\/([a-z]+)$/,
    routes: [["POST", /^call$/]],
    errorShape: {
      body: (type, message) => ({ error: { type, message } }),
      auth: "auth",
      unavailable: "unavailable",
      notFound: "not_found",
      forbidden: "forbidden",
      busy: "busy",
    },
    notApi: "not an API path",
    secretOf: (req) => req.headers["x-key"],
    routeOf: () => ({ base: baseOf(upstream), what: "Provider" }),
    drop: ["x-key"],
    authHeaders: async () => ({ "x-key": "operator" }),
    ...options,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const id = broker.register("org/repo");
  broker.provide(id, "anthropic");
  const secret = broker.agentToken(id);
  const call = () =>
    fetch(`${url}/api/call`, { method: "POST", headers: { "x-key": secret }, body: "{}" });
  const render = () => registry.render();
  // The page once `n` calls are counted: a call is, once its answer was read to its end.
  const counting = async (n) => {
    for (;;) {
      const text = await render();
      const counts = text.match(/^deckhand_model_calls_total\{.*\} \d+$/gm) ?? [];
      if (counts.reduce((sum, line) => sum + Number(line.split(" ")[1]), 0) >= n) return text;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { call, render, counting };
}

const series = (status) =>
  `deckhand_model_calls_total{provider="anthropic",agent="claude",status="${status}"}`;

test("a call is counted by its status, its length observed, the tokens its stream says added", async (t) => {
  let status = 200;
  const { call, counting } = await counted(t, (req, res) => {
    res.writeHead(status, { "content-type": "text/event-stream" });
    res.end(
      sse(
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "message_delta", usage: { output_tokens: 20 } },
      ),
    );
  });
  await (await call()).text();
  await (await call()).text();
  status = 529;
  await (await call()).text();
  // A failed answer's tokens aren't counted.
  status = 429;
  await (await call()).text();
  const text = await counting(4);
  assert.equal(sample(text, series("200")), "2");
  assert.equal(sample(text, series("529")), "1");
  assert.equal(sample(text, series("429")), "1");
  assert.equal(
    sample(text, 'deckhand_model_tokens_total{provider="anthropic",direction="input"}'),
    "20",
  );
  assert.equal(
    sample(text, 'deckhand_model_tokens_total{provider="anthropic",direction="output"}'),
    "40",
  );
  assert.equal(
    sample(text, 'deckhand_model_call_duration_seconds_count{provider="anthropic"}'),
    "4",
  );
  assert.equal(
    sample(text, 'deckhand_model_streams_interrupted_total{provider="anthropic"}'),
    undefined,
  );
});

test("a stream the provider cuts short is counted as such, with the tokens it said by then", async (t) => {
  const { call, render } = await counted(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      sse({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } }),
    );
    setTimeout(() => res.socket.destroy(), 20);
  });
  const res = await call();
  await assert.rejects(res.text());
  let text;
  // Counted once the proxy saw the cut, a moment after the client did.
  for (;;) {
    text = await render();
    if (sample(text, series("200"))) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sample(text, 'deckhand_model_streams_interrupted_total{provider="anthropic"}'), "1");
  assert.equal(
    sample(text, 'deckhand_model_tokens_total{provider="anthropic",direction="input"}'),
    "7",
  );
});

test("a provider that can't be reached, or a login that can't be used: counted apart", async (t) => {
  const { call, counting } = await counted(t, (req, res) => res.socket.destroy());
  assert.equal((await call()).status, 502);
  const unusable = await counted(t, () => assert.fail("not sent"), {
    authHeaders: async () => {
      throw new LoginError("spent", { refused: true });
    },
  });
  assert.equal((await unusable.call()).status, 503);
  assert.equal(sample(await counting(1), series("unreachable")), "1");
  const text = await unusable.render();
  assert.equal(sample(text, series("credential")), "1");
  // Never sent: no length.
  assert.equal(
    sample(text, 'deckhand_model_call_duration_seconds_count{provider="anthropic"}'),
    undefined,
  );
});

// #802: forward() says 502, `lost`, before unreachable() answers, whether the request went out or
// not: the call is counted, as unreachable.
test("a connection refused, or a provider silent till the call is cut: counted as unreachable", async (t) => {
  const port = await closedPort();
  const refused = await counted(t, () => assert.fail("nothing listens"), {
    routeOf: () => ({ base: baseOf(`http://127.0.0.1:${port}`), what: "Provider" }),
  });
  assert.equal((await refused.call()).status, 502);
  assert.equal(sample(await refused.counting(1), series("unreachable")), "1");
  const silent = await counted(t, () => {}, { idleMs: 50 });
  assert.equal((await silent.call()).status, 502);
  const text = await silent.counting(1);
  assert.equal(sample(text, series("unreachable")), "1");
  // Never answered: not a stream cut short.
  assert.equal(
    sample(text, 'deckhand_model_streams_interrupted_total{provider="anthropic"}'),
    undefined,
  );
});

test("the plans' usage at each scrape, a window past its reset at 0", async () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const store = openStore("memory:");
  const usage = createUsage({ plans: { claude: true, codex: true }, store, now: () => now });
  await usage.seen("claude", [
    { name: "5h", used: 0.19, resetsAt: now + 3600_000 },
    { name: "7d", used: 0.5, resetsAt: now - 1000 },
  ]);
  await usage.seen("codex", [{ name: "primary", used: 0.25, resetsAt: null }]);
  const registry = createRegistry();
  modelMetrics(registry, { readUsage: () => usage.read(), now: () => now });
  const text = await registry.render();
  assert.equal(sample(text, 'deckhand_plan_usage_ratio{provider="anthropic",window="5h"}'), "0.19");
  assert.equal(sample(text, 'deckhand_plan_usage_ratio{provider="anthropic",window="7d"}'), "0");
  assert.equal(
    sample(text, 'deckhand_plan_usage_ratio{provider="openai",window="primary"}'),
    "0.25",
  );
});

test("a login's refreshes, by result: once each, in the copy that did it", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "auth.json");
  writeFileSync(file, JSON.stringify({ token: "a", n: 0 }));
  const registry = createRegistry();
  const metrics = modelMetrics(registry);
  let outcome = () => ({ token: "b" });
  let expired = true;
  const login = planLogin({
    store: openStore("memory:"),
    seal: loginSeal(Buffer.alloc(32, 1)),
    name: "chatgpt",
    file,
    parse: (text) => JSON.parse(text),
    due: () => expired,
    refresh: async () => outcome(),
    headersOf: (json) => ({ authorization: `Bearer ${json.token}` }),
    accessOf: (json) => json.token,
    secretsOf: (json) => [json.token],
    refreshed: metrics.refreshed("codex"),
  });
  await login.headers();
  outcome = () => {
    throw new Error("timed out");
  };
  await assert.rejects(login.headers());
  outcome = () => {
    throw new LoginError("invalid_grant", { refused: true });
  };
  await assert.rejects(login.headers());
  // Refused: no copy spends it again, nothing more counted.
  await assert.rejects(login.headers());
  expired = false;
  const text = await registry.render();
  const refreshes = (result) =>
    sample(text, `deckhand_plan_login_refreshes_total{provider="openai",result="${result}"}`);
  assert.equal(refreshes("ok"), "1");
  assert.equal(refreshes("failed"), "1");
  assert.equal(refreshes("refused"), "1");
});

test("the calls' counter at 0 before any call, 200, 429 and 529: an increase() counts the first 429", async () => {
  const registry = createRegistry();
  modelMetrics(registry);
  const text = await registry.render();
  assert.equal(
    sample(text, 'deckhand_model_calls_total{provider="anthropic",agent="claude",status="529"}'),
    "0",
  );
  assert.equal(
    sample(text, 'deckhand_model_calls_total{provider="openai",agent="codex",status="429"}'),
    "0",
  );
  const series = text.split("\n").filter((l) => l.startsWith("deckhand_model_calls_total{"));
  assert.equal(series.length, PROVIDERS.length * AGENTS.length * 3);
});

test("without a registry, nothing is counted and nothing throws", () => {
  const metrics = modelMetrics(null);
  metrics.called({ provider: "anthropic", agent: "claude", status: "200", seconds: 1 });
  metrics.refreshed("codex")(null);
});

const tokens = (text, direction) =>
  sample(text, `deckhand_model_tokens_total{provider="anthropic",direction="${direction}"}`);

test("a compressed answer's tokens are read through its decompressor; an unknown encoding's aren't", async (t) => {
  const stream = sse(
    { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 4 } },
  );
  const whole = JSON.stringify({ type: "message", usage: { input_tokens: 20, output_tokens: 6 } });
  const answers = [
    ["text/event-stream", "gzip", gzipSync(stream)],
    ["application/json", "gzip", gzipSync(whole)],
    ["application/json", "br", brotliCompressSync(whole)],
    ["application/json", "compress", Buffer.from("not read")],
  ];
  let i = 0;
  const { call, counting } = await counted(t, (req, res) => {
    const [type, encoding, body] = answers[i++];
    res.writeHead(200, { "content-type": type, "content-encoding": encoding });
    res.end(body);
  });
  for (const _ of answers) await (await call()).arrayBuffer().catch(() => null);
  const text = await counting(answers.length);
  assert.equal(tokens(text, "input"), "43");
  assert.equal(tokens(text, "output"), "16");
});

test("an agent giving up mid-stream isn't a stream cut short; its call is counted", async (t) => {
  const { call, counting } = await counted(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      sse({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    );
  });
  const res = await call();
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  const text = await counting(1);
  assert.equal(sample(text, series("200")), "1");
  assert.equal(
    sample(text, 'deckhand_model_streams_interrupted_total{provider="anthropic"}'),
    undefined,
  );
  assert.equal(tokens(text, "input"), "5");
});

test("a call's length on the clock's time: in its bucket", async (t) => {
  let ms = 0;
  const clock = {
    setTimeout: () => ({}),
    clearTimeout: () => {},
    performance: { now: () => (ms += 45_000) },
  };
  const { call, counting } = await counted(
    t,
    (req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"),
    { clock },
  );
  await (await call()).text();
  const text = await counting(1);
  const bucket = (le) =>
    sample(text, `deckhand_model_call_duration_seconds_bucket{provider="anthropic",le="${le}"}`);
  assert.equal(bucket("30"), "0");
  assert.equal(bucket("60"), "1");
  assert.equal(
    sample(text, 'deckhand_model_call_duration_seconds_sum{provider="anthropic"}'),
    "45",
  );
});

test("every provider, agent and status has a series of its own: none folded into other", async () => {
  const warned = [];
  const registry = createRegistry({ log: (line) => warned.push(line) });
  const metrics = modelMetrics(registry);
  for (const provider of PROVIDERS)
    for (const agent of AGENTS)
      for (const status of STATUSES) metrics.called({ provider, agent, status, seconds: 1 });
  const text = await registry.render();
  const series = text.split("\n").filter((l) => l.startsWith("deckhand_model_calls_total{"));
  assert.equal(series.length, PROVIDERS.length * AGENTS.length * STATUSES.length);
  assert.ok(series.every((line) => line.endsWith(" 1")));
  assert.deepEqual(warned, []);
});
