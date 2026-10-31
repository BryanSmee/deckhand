// The models service's HTTP API (#504). Every endpoint but its health takes a service token,
// checked first against one table of what each caller may do (../lib/service-token.mjs
// serviceGuard()):
//
//   the sandboxes' agent calls, through the egress proxy (or the listener, relaying those of a
//   proxy from before this service): /anthropic/…, /openai/…, /google/…, /relay/<host>/…, with
//   the run's agent token in `x-deckhand-run-token` and the network (or pod) the caller vouches
//   they came from in `x-deckhand-sandbox` (lib/broker-client.mjs);
//   the orchestrator's: which credentials the operator set (GET /credentials, names only), what
//   redacts them from runs' output without them (GET /fingerprints), a run's API state (GET
//   /runs/:id/api), and the `models` stream (GET /events, POST /events/ack);
//   GET /health, /ready: liveness, and readiness (503 once draining).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { RUN_TOKEN_HEADER } from "../lib/broker-client.mjs";
import { drainable } from "../lib/drain.mjs";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { STREAM } from "./runs.mjs";

const SANDBOX = ["proxy", "orchestrator"];
const AGENT_PREFIXES = ["anthropic", "openai", "google", "relay"];

export const ROUTES = {
  ...Object.fromEntries(
    AGENT_PREFIXES.flatMap((prefix) => [
      [`POST /${prefix}/*`, SANDBOX],
      [`GET /${prefix}/*`, SANDBOX],
    ]),
  ),
  "GET /credentials": ["orchestrator"],
  "GET /fingerprints": ["orchestrator"],
  "GET /runs/:id/api": ["orchestrator"],
  "GET /events": ["orchestrator"],
  "POST /events/ack": ["orchestrator"],
};

// The orchestrator's long poll of the stream: under its own timeout.
export const EVENTS_WAIT_MS = 20_000;
const CONSUMER = "orchestrator";
const BODY_MAX = 64 * 1024;
// Shorter values are no credential (lib/redact.mjs MIN_LENGTH).
const MIN_LENGTH = 16;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// What redacts `values` from a text without them (lib/redact.mjs hashed()): a salt, and each
// value's length and salted SHA-256. A credential has too many unknown characters to be found
// back from its hash; a part of one would not, so only whole values are.
export function fingerprints(values, salt = randomBytes(16).toString("hex")) {
  const unique = [
    ...new Set(values.filter((v) => typeof v === "string" && v.length >= MIN_LENGTH)),
  ];
  return {
    salt,
    values: unique.map((value) => ({
      length: value.length,
      hash: createHash("sha256")
        .update(salt + value)
        .digest("hex"),
    })),
  };
}

// `endpoints`: { anthropic, openai, google }, each { handle(req, res) }; `runs`: runs.mjs's;
// `credentials`: the names of those the operator set; `secrets()`: their values, and the plan
// logins' tokens as last used; `keys`: the broker's public keys, for the service tokens;
// `bound`: lib/service-token.mjs networkCallers()'s, or null (Kubernetes).
export function createModelsHandler({
  endpoints,
  runs,
  store,
  credentials,
  secrets,
  keys,
  bound,
  draining = () => false,
  now = Date.now,
  sleep = realSleep,
  log = () => {},
}) {
  const guard = serviceGuard({ service: "models", keys, routes: ROUTES, bound, now });
  const salt = randomBytes(16).toString("hex");

  // The run's agent token back in the header the endpoint reads it from, in place of the
  // caller's service token, checked already.
  function agentCall(req, res, prefix) {
    const token = String(req.headers[RUN_TOKEN_HEADER] ?? "");
    delete req.headers.authorization;
    delete req.headers["x-api-key"];
    delete req.headers["x-goog-api-key"];
    if (prefix === "google") req.headers["x-goog-api-key"] = token;
    else req.headers.authorization = `Bearer ${token}`;
    const endpoint = prefix === "relay" ? endpoints.google : endpoints[prefix];
    return endpoint.handle(req, res);
  }

  // The orchestrator's long poll: what it hasn't acknowledged, waiting for one.
  async function events(res, url) {
    const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, EVENTS_WAIT_MS);
    const until = now() + wait;
    let gone = false;
    res.on("close", () => (gone = true));
    for (;;) {
      const found = await store.read(STREAM, CONSUMER, { count: 100 });
      if (found.length || gone || now() >= until) return sendJson(res, { events: found });
      await sleep(Math.min(250, until - now()));
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://models");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
      const ready = url.pathname === "/health" || !draining();
      return sendJson(res, { ok: ready }, ready ? 200 : 503);
    }
    guard(req);
    const prefix = /^\/([a-z]+)\//.exec(url.pathname)?.[1];
    if (AGENT_PREFIXES.includes(prefix)) return agentCall(req, res, prefix);
    if (req.method === "GET" && url.pathname === "/credentials") {
      return sendJson(res, { names: credentials });
    }
    if (req.method === "GET" && url.pathname === "/fingerprints") {
      return sendJson(res, fingerprints(secrets(), salt));
    }
    const api = /^\/runs\/([^/]+)\/api$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && api) {
      let id;
      try {
        id = decodeURIComponent(api);
      } catch {
        throw new Refused(400, "not a plain path");
      }
      return sendJson(res, await runs.state(id));
    }
    if (req.method === "GET" && url.pathname === "/events") return events(res, url);
    if (req.method === "POST" && url.pathname === "/events/ack") {
      const { ids } = (await readJsonBody(req, BODY_MAX)) ?? {};
      const acked = await store.ack(STREAM, CONSUMER, Array.isArray(ids) ? ids.map(String) : []);
      return sendJson(res, { acked });
    }
    sendJson(res, { message: "not found" }, 404);
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      if (error instanceof Refused) {
        if (!res.headersSent) sendJson(res, { message: error.message }, error.status);
        return;
      }
      log(`Models: ${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`);
      // A half-sent stream must not look complete.
      if (!res.headersSent) sendJson(res, { message: "the models service failed" }, 500);
      else res.destroy();
    }
  };
}

export function createModelsServer(options) {
  return drainable(createServer(createModelsHandler(options)));
}
