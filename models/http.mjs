// The models service's HTTP API (#504). Every endpoint but its health takes a service token,
// checked first against one table of what each caller may do (../lib/service-token.mjs
// serviceGuard()):
//
//   the sandboxes' agent calls, through the egress proxy: /anthropic/…, /openai/…, /google/…,
//   /relay/<host>/…, with
//   the run's agent token in `x-deckhand-run-token` and the network (or pod) the caller vouches
//   they came from in `x-deckhand-sandbox` (lib/broker-client.mjs);
//   the orchestrator's: which credentials the operator set (GET /credentials, names only), what
//   redacts them from runs' output without them (GET /fingerprints), a run's API state (GET
//   /runs/:id/api), how much of each plan the runs used (GET /usage, `?poll=1` while a dashboard
//   is open: usage.mjs), and the `models` stream (GET /events, POST /events/ack);
//   GET /health, /ready: liveness, and readiness (503 once draining).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AGENT_TOKEN_HEADERS, RUN_TOKEN_HEADER } from "../lib/broker-client.mjs";
import { drainable } from "../lib/drain.mjs";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { fingerprints } from "../lib/redact.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { STREAM } from "./runs.mjs";
import { withRequest } from "../lib/log.mjs";

const SANDBOX = ["proxy"];
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
  "GET /usage": ["orchestrator"],
  "GET /events": ["orchestrator"],
  "POST /events/ack": ["orchestrator"],
};

// The orchestrator's long poll of the stream: under its own timeout.
export const EVENTS_WAIT_MS = 20_000;
const CONSUMER = "orchestrator";
const BODY_MAX = 64 * 1024;

// What the listener redacts the credentials with, without them (GET /fingerprints).
export { fingerprints };

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// `endpoints`: { anthropic, openai, google }, each { handle(req, res) }; `runs`: runs.mjs's;
// `usage`: usage.mjs's;
// `credentials`: the names of those the operator set; `secrets()`: their values, and the plan
// logins' tokens as last used; `keys`: the broker's public keys, for the service tokens;
// `bound`: lib/service-token.mjs networkCallers()'s, or null (Kubernetes).
export function createModelsHandler({
  endpoints,
  runs,
  usage = null,
  store,
  credentials,
  secrets,
  keys,
  bound,
  draining = () => false,
  now = Date.now,
  sleep = realSleep,
  // The fingerprints' salt: one for every copy, and the same after a restart (fingerprintSalt()),
  // so that the listener holds one set, whichever copy it asks.
  salt = randomBytes(16).toString("hex"),
  log = () => {},
}) {
  const guard = serviceGuard({ service: "models", keys, routes: ROUTES, bound, now });

  // The run's agent token back in the header the endpoint reads it from, in place of the
  // caller's service token, checked already.
  function agentCall(req, res, prefix) {
    const token = String(req.headers[RUN_TOKEN_HEADER] ?? "");
    for (const name of AGENT_TOKEN_HEADERS) delete req.headers[name];
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
    if (req.method === "GET" && url.pathname === "/usage") {
      const poll = url.searchParams.get("poll") === "1";
      return sendJson(res, { plans: usage ? await usage.read({ poll }) : [] });
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
      (log.error ?? log)(`Models: ${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`);
      // A half-sent stream must not look complete.
      if (!res.headersSent) sendJson(res, { message: "the models service failed" }, 500);
      else res.destroy();
    }
  };
}

export function createModelsServer(options) {
  return drainable(createServer(withRequest(createModelsHandler(options))));
}
