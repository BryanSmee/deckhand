// The models service's metrics (#657, ../lib/metrics.mjs): the agents' API calls that go through
// it with the operator's credentials, the tokens their answers say they used, the plans' usage
// and the refreshes of their logins. Labels are bounded: the provider, the agent, the status
// (statusLabel()); never a run or a credential's name, nor a model's but as the name of an
// Antigravity plan's window (usage.mjs antigravityPolled(): a quota is named after its first
// model, which may change from one reading to the next, a few series at most).
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { STATUS_LABELS, statusLabel } from "../lib/metrics.mjs";

// The providers a call goes to (the runs' `provider`), the agents whose calls they are (each
// endpoint's: anthropic.mjs, openai.mjs, google.mjs).
export const PROVIDERS = ["anthropic", "openrouter", "openai", "google"];
export const AGENTS = ["claude", "codex", "antigravity"];
// A call's status, as every service labels one (lib/metrics.mjs statusLabel(): 429 a rate or plan
// limit, 529 Anthropic overloaded; `unreachable`, no answer from the provider), and `credential`:
// not sent, the operator's credential unusable (a login that can't be refreshed).
export const STATUSES = [...STATUS_LABELS, "credential"];
// Those at 0 from the start, for the alerts' rates (deploy/alerts: DeckhandModelsLimited).
const AT_ZERO = ["200", "429", "529"];
export const DIRECTIONS = ["input", "output", "cache_read", "cache_write"];
// Each plan's provider (usage.mjs PLANS), as the calls' label names it.
export const PLAN_PROVIDERS = { claude: "anthropic", codex: "openai", antigravity: "google" };

// An agent's call streams for minutes: from a model list's milliseconds to IDLE_MS.
export const CALL_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

// The largest answer (a JSON one) or SSE line read for its usage: past it, its tokens aren't
// counted, and nothing is held of it. An OpenAI stream's last event holds the whole response.
export const MAX_READ = 4 * 1024 * 1024;

export const statusOf = (status, { lost = false } = {}) => statusLabel(lost ? null : status);

const count = (n) => (Number.isFinite(n) && n >= 0 ? n : 0);

// One parsed object's usage, in DIRECTIONS, or null when it says none; `merge`: a later part of
// the same answer's (Anthropic's message_delta, cumulative but for the fields it leaves out),
// else the whole usage so far (OpenAI's last event, Gemini's every chunk, cumulative). Input is
// what wasn't read from the cache: OpenAI and Gemini count cached tokens in their input,
// Anthropic apart.
function usageIn(o) {
  if (!o || typeof o !== "object") return null;
  // Anthropic (and OpenRouter's Anthropic API): message_start, message_delta, or a whole message.
  const anthropic =
    o.type === "message_start" ? o.message?.usage : /^message(_delta)?$/.test(o.type) && o.usage;
  if (anthropic && typeof anthropic === "object") {
    const parts = {
      input: anthropic.input_tokens,
      output: anthropic.output_tokens,
      cache_read: anthropic.cache_read_input_tokens,
      cache_write: anthropic.cache_creation_input_tokens,
    };
    const usage = Object.fromEntries(
      Object.entries(parts).filter(([, n]) => typeof n === "number" && n >= 0),
    );
    return { usage, merge: true };
  }
  // OpenAI's Responses API (ChatGPT's Codex backend too): its last event, or a whole response.
  const openai = /^response\.(completed|incomplete|failed)$/.test(o.type)
    ? o.response?.usage
    : o.object === "response" && o.usage;
  if (openai && typeof openai === "object") {
    const cached = count(openai.input_tokens_details?.cached_tokens);
    return {
      usage: {
        input: Math.max(0, count(openai.input_tokens) - cached),
        output: count(openai.output_tokens),
        cache_read: cached,
      },
    };
  }
  // Gemini, and the Antigravity CLI's Cloud Code calls (its answer under `response`).
  const gemini = o.usageMetadata ?? o.response?.usageMetadata;
  if (gemini && typeof gemini === "object") {
    const cached = count(gemini.cachedContentTokenCount);
    return {
      usage: {
        input: Math.max(0, count(gemini.promptTokenCount) - cached),
        output: count(gemini.candidatesTokenCount) + count(gemini.thoughtsTokenCount),
        cache_read: cached,
      },
    };
  }
  return null;
}

// What an answer says it used, read as it streams: server-sent events line by line, any other
// answer (JSON, Gemini's streamed array) whole; a line or an answer past MAX_READ is left out.
// Only text that names a usage is parsed. → { write(chunk), end() → { input, output, … }, or
// null when it said none }.
export function usageReader(contentType = "") {
  const events = /^text\/event-stream/i.test(String(contentType));
  const decoder = new StringDecoder("utf8");
  let usage = null;
  let text = ""; // the line under way, or the whole answer
  let skipping = false; // a line past MAX_READ, left out to its end; an answer, whole
  const seen = (part) => {
    if (!part.includes("usage")) return;
    let json;
    try {
      json = JSON.parse(part);
    } catch {
      return;
    }
    for (const o of Array.isArray(json) ? json : [json]) {
      const found = usageIn(o);
      if (found) usage = found.merge ? { ...usage, ...found.usage } : found.usage;
    }
  };
  const line = (part) => {
    const data = /^data:\s?(.*)$/s.exec(part.replace(/\r$/, ""));
    if (data) seen(data[1]);
  };
  return {
    write(chunk) {
      if (!events) {
        if (skipping) return;
        text += decoder.write(chunk);
        if (text.length > MAX_READ) [text, skipping] = ["", true];
        return;
      }
      const lines = (text + decoder.write(chunk)).split("\n");
      text = lines.pop();
      for (const part of lines) {
        if (skipping) skipping = false;
        else line(part);
      }
      if (text.length > MAX_READ) [text, skipping] = ["", true];
    },
    end() {
      if (!skipping) (events ? line : seen)(text + decoder.end());
      text = "";
      return usage;
    },
  };
}

// The decompressors of the encodings an answer may come in: the agent's `accept-encoding` goes
// on to the provider (upstream.mjs forwarded()), and the answer back as it came.
const DECODERS = {
  gzip: zlib.createGunzip,
  "x-gzip": zlib.createGunzip,
  deflate: zlib.createInflate,
  br: zlib.createBrotliDecompress,
  ...(zlib.createZstdDecompress && { zstd: zlib.createZstdDecompress }),
};

// usageReader() for an answer with these `headers`, through its decompressor when it is
// encoded; another encoding (or several) says no usage. → { write(chunk), end() → a promise of
// usageReader()'s }, what was read by then when the answer was cut short.
export function usageTap(headers = {}) {
  const reader = usageReader(headers["content-type"]);
  const encoding = String(headers["content-encoding"] ?? "identity")
    .trim()
    .toLowerCase();
  if (encoding === "identity" || encoding === "") {
    return { write: (chunk) => reader.write(chunk), end: async () => reader.end() };
  }
  if (!Object.hasOwn(DECODERS, encoding)) return { write() {}, end: async () => null };
  const decoder = DECODERS[encoding]();
  decoder.on("data", (chunk) => reader.write(chunk));
  const ended = new Promise((resolve) => {
    decoder.on("end", resolve);
    // Cut short, or garbled: what came before counts.
    decoder.on("error", resolve);
  });
  return {
    write: (chunk) => decoder.write(chunk),
    end: async () => {
      decoder.end();
      await ended;
      return reader.end();
    },
  };
}

// The models service's metrics in `registry` (lib/metrics.mjs createRegistry()'s), or what
// counts nothing without one (the tests'). `readUsage()`: usage.mjs's read(), the plans' usage at
// each scrape.
export function modelMetrics(registry, { readUsage = async () => [], now = Date.now } = {}) {
  if (!registry) {
    return { called() {}, refreshed: () => () => {} };
  }
  const calls = registry.counter(
    "deckhand_model_calls_total",
    "The agents' API calls through the models service, by provider, agent and status (unreachable: no answer; credential: not sent, the login unusable).",
    {
      labels: ["provider", "agent", "status"],
      values: { provider: PROVIDERS, agent: AGENTS, status: STATUSES },
      maxSeries: (PROVIDERS.length + 1) * (AGENTS.length + 1) * STATUSES.length,
    },
  );
  // At 0 from the start: a rate needs its first sample, or the first 429 of a provider never
  // counts in an increase().
  for (const provider of PROVIDERS) {
    for (const agent of AGENTS)
      for (const status of AT_ZERO) calls.inc({ provider, agent, status }, 0);
  }
  const durations = registry.histogram(
    "deckhand_model_call_duration_seconds",
    "How long an agent's API call took, its answer streamed whole, in seconds.",
    { labels: ["provider"], values: { provider: PROVIDERS }, buckets: CALL_BUCKETS },
  );
  const interrupted = registry.counter(
    "deckhand_model_streams_interrupted_total",
    "Answers cut short on the provider's side: its connection lost, or no byte for 10 minutes.",
    { labels: ["provider"], values: { provider: PROVIDERS } },
  );
  const tokens = registry.counter(
    "deckhand_model_tokens_total",
    "Tokens the providers' answers say the calls used: input (not read from the cache), output, cache_read, cache_write.",
    {
      labels: ["provider", "direction"],
      values: { provider: PROVIDERS, direction: DIRECTIONS },
    },
  );
  const refreshes = registry.counter(
    "deckhand_plan_login_refreshes_total",
    "The plans' logins this service refreshed, by provider and result (ok, refused: signing in again is needed, failed).",
    {
      labels: ["provider", "result"],
      values: { provider: Object.values(PLAN_PROVIDERS), result: ["ok", "refused", "failed"] },
    },
  );
  // Each plan's windows as last read (usage.mjs read()): a window past its reset is 0.
  registry.gauge(
    "deckhand_plan_usage_ratio",
    "How much of each plan's window the runs used, 0 to 1 (window: 5h, 7d, …; an Antigravity model's).",
    {
      labels: ["provider", "window"],
      values: { provider: Object.values(PLAN_PROVIDERS) },
      collect: async () =>
        (await readUsage()).flatMap(({ plan, windows }) =>
          windows.map(({ name, used, resetsAt }) => [
            { provider: PLAN_PROVIDERS[plan] ?? plan, window: name },
            resetsAt !== null && resetsAt <= now() ? 0 : used,
          ]),
        ),
    },
  );

  return {
    // An agent's call, once over: `status` its answer's (statusOf()), `seconds` how long it took
    // (none: never sent), `cut` its answer cut short, `used` what it said it used.
    called({ provider, agent, status, seconds = null, cut = false, used = null }) {
      calls.inc({ provider, agent, status });
      if (seconds !== null) durations.observe({ provider }, seconds);
      if (cut) interrupted.inc({ provider });
      for (const direction of DIRECTIONS) {
        if (used?.[direction] > 0) tokens.inc({ provider, direction }, used[direction]);
      }
    },
    // `plan`'s refresh (usage.mjs PLANS' names) → what its result is counted with: none, ok;
    // an error, refused when the login is unusable till signed in again (a 401), else failed.
    refreshed: (plan) => (error) =>
      refreshes.inc({
        provider: PLAN_PROVIDERS[plan] ?? plan,
        result: !error ? "ok" : error.status === 401 ? "refused" : "failed",
      }),
  };
}

// Every metric its server declares, and test/metrics-services.test.mjs: modelMetrics()'s alone.
export const declareMetrics = modelMetrics;
