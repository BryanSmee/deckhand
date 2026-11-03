// The orchestrator's services port (#506), on the networks it shares with each caller alone
// (compose.yaml):
//
//   POST /runs/:run/tokens              the runner's: a run's first tokens, once its network or
//                                       pod exists (sandbox-spec.mjs tokenEnv(), which the broker
//                                       service signs): only for a run being started
//                                       (`pendingTokens`), with the claims the orchestrator
//                                       decided, never the runner's
//   * /edge/*                           edge's: the dashboard's API and /status, as edge
//                                       passes them on with the user it signed in (../edge/forward.mjs), answered by http.mjs
//
// The repos' tarballs and blobs are the github service's (../github/service.mjs, #502).
//
// Each route names its callers (ROUTES, serviceGuard()), whose service tokens come from the
// broker service and are checked with its keys: the user header counts from edge's token alone.
import { createServer } from "node:http";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { withRequest } from "../lib/log.mjs";

export const ROUTES = {
  "POST /runs/:run/tokens": ["runner"],
  "GET /edge/*": ["edge"],
  "POST /edge/*": ["edge"],
};

// What edge says of each request (../edge/forward.mjs, the same names).
const USER_HEADER = "x-deckhand-user";
const LOCAL_HEADER = "x-deckhand-local";
const HOST_HEADER = "x-deckhand-host";
const ORIGIN_HEADER = "x-deckhand-origin";
// A GitHub login.
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

const MAX_BODY = 64 * 1024;

// `keys`: the broker service's public keys ({ get(kid) }, broker-service.mjs serviceKeys());
// `bound`: lib/service-token.mjs networkCallers()'s; `pendingTokens`: run → tokens(sandbox)
// (../runner/client.mjs start()); `edge()`: http.mjs handle(), or null while the orchestrator
// isn't ready to answer it; `active()`: whether this copy holds the lease. A waiting copy
// answers its probes (GET /health, and /ready: 503), and 503 to every call, which its callers
// try again on the copy that acts (lib/service-client.mjs). `waiting()`: how many items of its
// state wait to be written to the store (lib/store-map.mjs), which /ready says: the store away,
// the copy acting still answers (no other could do better), and what it changes lands later.
export function createServicesHttp({
  keys,
  bound,
  pendingTokens,
  edge = () => null,
  active = () => true,
  waiting = () => 0,
  // Whether a login edge signed in is one of this orchestrator's ALLOWED_USERS too: the two
  // read the same setting, and one of them out of date lets nobody through that it refuses.
  allowed = () => true,
  log = () => {},
  now = Date.now,
  // What GET /health says: when it started, its version (../lib/health.mjs).
  health = healthInfo(),
}) {
  const guard = serviceGuard({ service: "orchestrator", keys, routes: ROUTES, bound, now });

  // Edge's posts being answered: a copy that stops waits for them before it lets its lease go
  // (posting()), so that what they change is saved first.
  const posting = new Set();

  // Edge's request, as it was: its path without /edge, the browser's Host and Origin.
  function fromEdge(req, res) {
    const handle = edge();
    if (!handle) throw new Refused(503, "not ready");
    if (req.method !== "GET") {
      const answered = new Promise((resolve) => res.on("close", resolve));
      posting.add(answered);
      answered.then(() => posting.delete(answered));
    }
    const user = String(req.headers[USER_HEADER] ?? "");
    const local = req.headers[LOCAL_HEADER] === "1";
    for (const [from, to] of [
      [HOST_HEADER, "host"],
      [ORIGIN_HEADER, "origin"],
    ]) {
      if (req.headers[from]) req.headers[to] = req.headers[from];
      else delete req.headers[to];
    }
    req.url = req.url.slice("/edge".length) || "/";
    const login = LOGIN.test(user) ? user.toLowerCase() : null;
    return handle(req, res, { user: login && allowed(login) ? login : null, local });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://orchestrator");
    if (req.method === "GET" && url.pathname === "/health")
      return sendJson(res, healthAnswer(health));
    if (req.method === "GET" && url.pathname === "/ready") {
      return sendJson(res, { ok: active(), waiting: waiting() }, active() ? 200 : 503);
    }
    if (!active()) throw new Refused(503, "this copy waits for the orchestrator's lease");
    if (url.pathname.startsWith("/edge/")) {
      guard(req);
      return fromEdge(req, res);
    }
    const run = /^\/runs\/([^/]+)\/tokens$/.exec(url.pathname);
    if (run && req.method === "POST") {
      guard(req);
      const id = decodeURIComponent(run[1]);
      const tokens = pendingTokens.get(id);
      if (!tokens) throw new Refused(404, `${id} isn't being started`);
      const { sandbox } = await readJsonBody(req, MAX_BODY);
      if (!sandbox || typeof sandbox !== "string") throw new Refused(400, "sandbox?");
      return sendJson(res, { env: await tokens(sandbox) });
    }
    // Anything else, from any caller.
    guard(req);
    throw new Refused(404, "no such endpoint");
  }

  const server = createServer(
    withRequest((req, res) =>
      handle(req, res).catch((error) => {
        if (res.headersSent) return res.destroy();
        // Not this copy's to answer (it waits, or stops): the connection isn't kept for the next
        // call, which then reaches the copy that acts.
        if (error instanceof Refused && error.status === 503) res.setHeader("connection", "close");
        if (error instanceof Refused)
          return sendJson(res, { message: error.message }, error.status);
        (log.error ?? log)(`Services port: ${req.method} ${req.url}: ${error.stack ?? error}`);
        sendJson(res, { message: "failed" }, 500);
      }),
    ),
  );
  server.posting = () => [...posting];
  return server;
}
