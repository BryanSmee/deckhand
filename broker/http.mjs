// The broker service's HTTP API (#505). Every endpoint but its keys, its service tokens and its
// health takes a service token, checked first against one table of what each caller may do
// (../lib/service-token.mjs serviceGuard()):
//
//   POST /service-tokens        any service, proven by its network or pod (callers.mjs): its
//                               tokens for the services it calls
//   GET  /keys                  the public keys tokens are checked with, offline
//   GET  /health, /ready        liveness, and readiness (503 once draining)
//
//   the orchestrator's: the live runs (GET /runs, PUT and DELETE /runs/:id), a key of the
//   listener's from before this service (POST /keys), the `runs` stream (GET /events, POST
//   /events/ack), and the screenshots it copies (GET and DELETE /shots/:folder/:name);
//   the runner's: a run's first tokens (POST /runs/:id/tokens), its inbox and files (POST
//   /runs/:id/inbox, PUT /runs/:id/files/:name);
//   the sandboxes', through the egress proxy (#511), which vouches for the network or pod they
//   came from (`x-deckhand-sandbox`, as the listener's egress policy told it) and passes their
//   run token on in `x-deckhand-run-token`: renewal (POST /run/token), the inbox (GET
//   /run/inbox?from=<byte>), the CA and digest (GET /run/ca, /run/digest), screenshots (PUT
//   /run/shots/<file>).
//
// The listener holds the orchestrator and the runner until they move out (#503, #506): it calls
// as the orchestrator, which the runner's endpoints take meanwhile. It also relays the calls of
// sandboxes that reach it rather than this service (a proxy from before it, a sandbox from before
// #511), vouching for them as the proxy does.
import { createServer } from "node:http";
import { drainable } from "../lib/drain.mjs";
import { readBody, readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { issueServiceTokens, serviceGuard } from "../lib/service-token.mjs";
import { FILES } from "./files.mjs";
import { runFields, STREAM } from "./runs.mjs";

// The headers the proxy (or the listener, relaying) sets on a sandbox's call: whatever the
// sandbox sent in them was replaced.
export const SANDBOX_HEADER = "x-deckhand-sandbox";
export const RUN_TOKEN_HEADER = "x-deckhand-run-token";

// Until the runner and the orchestrator move out of the listener, which calls as the
// orchestrator (#503, #506): the runner's endpoints take it too, and the sandboxes' (its relay).
const RUNNER = ["runner", "orchestrator"];
const SANDBOX = ["proxy", "orchestrator"];

export const ROUTES = {
  "GET /runs": ["orchestrator"],
  "PUT /runs/:id": ["orchestrator"],
  "DELETE /runs/:id": ["orchestrator"],
  "POST /runs/:id/tokens": RUNNER,
  "POST /runs/:id/inbox": RUNNER,
  "PUT /runs/:id/files/:name": RUNNER,
  "POST /keys": ["orchestrator"],
  "GET /events": ["orchestrator"],
  "POST /events/ack": ["orchestrator"],
  "GET /shots/:folder/:name": ["orchestrator"],
  "DELETE /shots/:folder/:name": ["orchestrator"],
  "POST /run/token": SANDBOX,
  "GET /run/inbox": SANDBOX,
  "GET /run/ca": SANDBOX,
  "GET /run/digest": SANDBOX,
  "PUT /run/shots/:name": SANDBOX,
  // A file the run has none of: 404, which the sandbox's deckhand-files doesn't ask again.
  "GET /run/*": SANDBOX,
};

// The orchestrator's long poll of the stream: under its own timeout.
export const EVENTS_WAIT_MS = 20_000;
const CONSUMER = "orchestrator";
const BODY_MAX = 64 * 1024;
// An inbox append: as long as a message, and a little more.
const INBOX_MAX = 8 * 1024 * 1024;
const FILE_MAX = 4 * 1024 * 1024;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// `runs`, `files`: runs.mjs's and files.mjs's; `callers`: callers.mjs's; `signing`: the key, for
// the services' tokens; `store`: for the stream.
export function createBrokerHandler({
  runs,
  files,
  callers,
  signing,
  store,
  draining = () => false,
  now = Date.now,
  sleep = realSleep,
  log = () => {},
}) {
  const guard = serviceGuard({
    service: "broker",
    keys: runs.serviceKeys(),
    routes: ROUTES,
    bound: callers.bound,
    now,
  });

  // What the proxy passed on of a sandbox's call: its run token, and the network (or pod) it
  // vouches the call came from.
  const sandboxOf = (req) => ({
    token: String(req.headers[RUN_TOKEN_HEADER] ?? ""),
    sandbox: String(req.headers[SANDBOX_HEADER] ?? ""),
  });

  async function runCall(req, res, url) {
    const path = url.pathname;
    if (req.method === "POST" && path === "/run/token") {
      const { token, sandbox } = sandboxOf(req);
      const renewed = await runs.renew(token, sandbox);
      if (!renewed.token) return sendJson(res, { message: renewed.message }, renewed.status);
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      return res.end(`${renewed.token}\n`);
    }
    const { token, sandbox } = sandboxOf(req);
    const checked = await runs.check(token, sandbox);
    if (!checked.record) return sendJson(res, { message: checked.message }, checked.status);
    const { record } = checked;
    if (req.method === "GET" && path === "/run/inbox") {
      const from = Number(url.searchParams.get("from") ?? 0);
      if (!Number.isSafeInteger(from) || from < 0) {
        return sendJson(res, { message: "from: a byte offset" }, 400);
      }
      // A sandbox that goes away stops waiting.
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      const lines = await files.pollInbox(record.id, from, { signal: gone.signal });
      if (lines === null) return sendJson(res, { message: "no inbox" }, 404);
      if (!lines.length) return res.writeHead(204).end();
      return res.writeHead(200, { "content-type": "application/x-ndjson" }).end(lines);
    }
    const name = /^\/run\/(ca|digest)$/.exec(path)?.[1];
    if (req.method === "GET" && name) {
      const data = await files.getFile(record.id, name);
      if (data === null) return sendJson(res, { message: `this run has no ${name}` }, 404);
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
    }
    const shot = /^\/run\/shots\/([^/]+)$/.exec(path)?.[1];
    if (req.method === "PUT" && shot) {
      const { status, message } = await files.putShot(req, record, decodeURIComponent(shot));
      return status === 204 ? res.writeHead(204).end() : sendJson(res, { message }, status);
    }
    sendJson(res, { message: "not found" }, 404);
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

  async function serviceCall(req, res, url) {
    const path = url.pathname;
    const id = /^\/runs\/([^/]+)/.exec(path)?.[1];
    const run = id && decodeURIComponent(id);
    if (req.method === "GET" && path === "/runs") return sendJson(res, { runs: await runs.list() });
    if (req.method === "PUT" && run && path === `/runs/${id}`) {
      const body = await readJsonBody(req, BODY_MAX);
      await runs.put(run, runFields(body));
      return res.writeHead(204).end();
    }
    if (req.method === "DELETE" && run && path === `/runs/${id}`) {
      const had = await runs.end(run);
      await files.remove(run);
      return sendJson(res, { ended: had });
    }
    if (req.method === "POST" && run && path === `/runs/${id}/tokens`) {
      const body = await readJsonBody(req, BODY_MAX);
      const issued = await runs.issue(run, runFields(body));
      if (!issued.token) return sendJson(res, { message: issued.message }, issued.status);
      return sendJson(res, issued);
    }
    if (req.method === "POST" && run && path === `/runs/${id}/inbox`) {
      const offset = Number(url.searchParams.get("offset"));
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return sendJson(res, { message: "offset: a byte offset" }, 400);
      }
      const data = await readBody(req, INBOX_MAX);
      const answer = await files.appendInbox(run, offset, data);
      return sendJson(res, answer, answer.gap ? 409 : 200);
    }
    const file = /^\/runs\/[^/]+\/files\/([^/]+)$/.exec(path)?.[1];
    if (req.method === "PUT" && run && file) {
      if (!FILES.includes(file)) return sendJson(res, { message: `no file ${file}` }, 404);
      await files.putFile(run, file, await readBody(req, FILE_MAX));
      return res.writeHead(204).end();
    }
    if (req.method === "POST" && path === "/keys") {
      const { pem } = await readJsonBody(req, BODY_MAX);
      const imported = await runs.importKey(pem);
      if (!imported.kid) return sendJson(res, { message: imported.message }, imported.status);
      log(
        `Broker: a key of the listener's from before this service, ${imported.kid}, checks run tokens`,
      );
      return sendJson(res, imported);
    }
    if (req.method === "GET" && path === "/events") return events(res, url);
    if (req.method === "POST" && path === "/events/ack") {
      const { ids } = await readJsonBody(req, BODY_MAX);
      const acked = await store.ack(STREAM, CONSUMER, Array.isArray(ids) ? ids.map(String) : []);
      return sendJson(res, { acked });
    }
    const shot = /^\/shots\/([^/]+)\/([^/]+)$/.exec(path);
    if (shot && (req.method === "GET" || req.method === "DELETE")) {
      const [folder, name] = shot.slice(1).map(decodeURIComponent);
      if (req.method === "DELETE")
        return sendJson(res, { deleted: await files.deleteShot(folder, name) });
      const data = await files.getShot(folder, name);
      if (data === null) return sendJson(res, { message: "no such screenshot" }, 404);
      return res.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
    }
    sendJson(res, { message: "not found" }, 404);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
      const ready = url.pathname === "/health" || !draining();
      return sendJson(res, { ok: ready }, ready ? 200 : 503);
    }
    if (req.method === "GET" && url.pathname === "/keys")
      return sendJson(res, await runs.publicKeys());
    if (req.method === "POST" && url.pathname === "/service-tokens") {
      const caller = await callers.callerOf(req);
      const { audiences } = await readJsonBody(req, BODY_MAX);
      const tokens = issueServiceTokens(
        caller,
        Array.isArray(audiences) ? audiences : [],
        signing,
        {
          now: now(),
        },
      );
      return sendJson(res, { tokens });
    }
    guard(req);
    if (url.pathname.startsWith("/run/")) return runCall(req, res, url);
    return serviceCall(req, res, url);
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      if (error instanceof Refused) {
        if (!res.headersSent) sendJson(res, { message: error.message }, error.status);
        return;
      }
      log(`Broker: ${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`);
      if (!res.headersSent) sendJson(res, { message: "the broker failed" }, 500);
      else res.destroy();
    }
  };
}

export function createBrokerServer(options) {
  return drainable(createServer(createBrokerHandler(options)));
}
