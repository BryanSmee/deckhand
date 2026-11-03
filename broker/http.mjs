// The broker service's HTTP API (#505). Every endpoint but its keys, its service tokens and its
// health takes a service token, checked first against one table of what each caller may do
// (../lib/service-token.mjs serviceGuard()):
//
//   POST /service-tokens        any service, proven by its network or pod (callers.mjs): its
//                               tokens for the services it calls
//   GET  /keys                  the public keys tokens are checked with, offline
//   GET  /health, /ready        liveness ({ ok, startedAt, version }, ../lib/health.mjs), and
//                               readiness (503 once draining)
//
//   the orchestrator's: the live runs (GET /runs, PUT and DELETE /runs/:id), the `runs` stream
//   (GET /events, POST /events/ack), the screenshots it kept before the broker did, moved here
//   at its start (PUT /shots/:folder/:name), those of a run retention removes (DELETE
//   /shots/:folder), and a run's
//   first tokens (POST /runs/:id/tokens), with the claims it decided. Each of its calls but a
//   GET carries its fencing epoch (../lib/fence.mjs, #506): one older than the newest seen is
//   refused (409), so a copy that lost its lease ends no run and gets no token signed;
//   the runner's: a run's inbox and files (POST /runs/:id/inbox, PUT /runs/:id/files/:name);
//   the models service's: whether a run still goes, and its agent's provider (GET /runs/:id);
//   edge's: a screenshot, which it serves to anyone (GET /shots/:folder/:name, #609);
//   the sandboxes', through the egress proxy (#511), which vouches for the network or pod they
//   came from (`x-deckhand-sandbox`, as the listener's egress policy told it) and passes their
//   run token on in `x-deckhand-run-token`: renewal (POST /run/token), the inbox (GET
//   /run/inbox?from=<byte>), the CA and digest (GET /run/ca, /run/digest), screenshots (PUT
//   /run/shots/<file>).
import { createServer } from "node:http";
import { drainable } from "../lib/drain.mjs";
import { readBody, readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { createFence } from "../lib/fence.mjs";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { issueServiceTokens, serviceGuard } from "../lib/service-token.mjs";
import { IMAGE_TYPES, SHOT_NAME } from "../lib/shots.mjs";
import { FILES } from "./files.mjs";
import { runFields, STREAM } from "./runs.mjs";

// The headers the proxy sets on a sandbox's call: whatever the sandbox sent in them was
// replaced.
import { RUN_TOKEN_HEADER, SANDBOX_HEADER } from "../lib/broker-client.mjs";
import { withRequest } from "../lib/log.mjs";
export { RUN_TOKEN_HEADER, SANDBOX_HEADER };

const RUNNER = ["runner"];
const SANDBOX = ["proxy"];

export const ROUTES = {
  "GET /runs": ["orchestrator"],
  // Whether a run still goes, and its agent's provider: what the models service checks an agent
  // token against (#504).
  "GET /runs/:id": ["models"],
  "PUT /runs/:id": ["orchestrator"],
  "DELETE /runs/:id": ["orchestrator"],
  // A run's first tokens take every claim from the caller (repo, mode, branches): the
  // orchestrator decides them, the runner asks it (#503), so it can't choose what they allow.
  "POST /runs/:id/tokens": ["orchestrator"],
  "POST /runs/:id/inbox": RUNNER,
  "PUT /runs/:id/files/:name": RUNNER,
  "GET /events": ["orchestrator"],
  "POST /events/ack": ["orchestrator"],
  // Edge serves them (#609). The orchestrator's GET and DELETE of one are the release before's,
  // which copied them away: kept through this update, its DELETE deleting nothing now.
  "GET /shots/:folder/:name": ["edge", "orchestrator"],
  "PUT /shots/:folder/:name": ["orchestrator"],
  "DELETE /shots/:folder/:name": ["orchestrator"],
  "DELETE /shots/:folder": ["orchestrator"],
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

// A path segment, decoded; one that isn't valid percent-encoding is refused.
function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new Refused(400, "not a plain path");
  }
}

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
  // What GET /health says: when it started, its version (../lib/health.mjs).
  health = healthInfo(),
}) {
  const guard = serviceGuard({
    service: "broker",
    keys: runs.serviceKeys(),
    routes: ROUTES,
    bound: callers.bound,
    now,
  });
  const fence = createFence({ store, service: "broker", now });

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
      const { status, message } = await files.putShot(req, record, decoded(shot));
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
    const run = id && decoded(id);
    if (req.method === "GET" && path === "/runs") return sendJson(res, { runs: await runs.list() });
    if (req.method === "GET" && run && path === `/runs/${id}`) {
      const record = await runs.get(run);
      if (!record) return sendJson(res, { message: "unknown or finished run" }, 404);
      const { provider = null, credential = null, sandbox = null } = record;
      return sendJson(res, { provider, credential, sandbox });
    }
    if (req.method === "PUT" && run && path === `/runs/${id}`) {
      const body = await readJsonBody(req, BODY_MAX);
      await runs.put(run, runFields(body), body?.issued);
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
    if (req.method === "GET" && path === "/events") return events(res, url);
    if (req.method === "POST" && path === "/events/ack") {
      const { ids } = (await readJsonBody(req, BODY_MAX)) ?? {};
      const acked = await store.ack(STREAM, CONSUMER, Array.isArray(ids) ? ids.map(String) : []);
      return sendJson(res, { acked });
    }
    const folder = /^\/shots\/([^/]+)$/.exec(path)?.[1];
    if (req.method === "DELETE" && folder) {
      return sendJson(res, { deleted: await files.removeShots(decoded(folder)) });
    }
    const shot = /^\/shots\/([^/]+)\/([^/]+)$/.exec(path);
    if (shot) {
      const [folder, name] = shot.slice(1).map(decoded);
      if (req.method === "PUT") {
        const { status, message } = await files.moveShot(req, folder, name);
        return status === 204 ? res.writeHead(204).end() : sendJson(res, { message }, status);
      }
      // The release before's, once it copied one: it stays here, where edge serves it from.
      if (req.method === "DELETE") return sendJson(res, { deleted: false });
      if (req.method === "GET") {
        const data = await files.getShot(folder, name);
        if (data === null) return sendJson(res, { message: "no such screenshot" }, 404);
        const type = IMAGE_TYPES[SHOT_NAME.exec(name)[1]];
        return res.writeHead(200, { "content-type": type }).end(data);
      }
    }
    sendJson(res, { message: "not found" }, 404);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://broker");
    if (req.method === "GET" && url.pathname === "/health")
      return sendJson(res, healthAnswer(health));
    if (req.method === "GET" && url.pathname === "/ready") {
      const ready = !draining();
      return sendJson(res, { ok: ready }, ready ? 200 : 503);
    }
    if (req.method === "GET" && url.pathname === "/keys")
      return sendJson(res, await runs.publicKeys());
    if (req.method === "POST" && url.pathname === "/service-tokens") {
      const { audiences, service } = (await readJsonBody(req, BODY_MAX)) ?? {};
      const caller = await callers.callerOf(req, typeof service === "string" ? service : null);
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
    const caller = guard(req);
    if (url.pathname.startsWith("/run/")) return runCall(req, res, url);
    // What the orchestrator changes carries its fencing epoch (#506): a copy of it that lost its
    // lease can't end a run, nor have its tokens signed.
    if (caller === "orchestrator" && req.method !== "GET") await fence(req);
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
      (log.error ?? log)(`Broker: ${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`);
      if (!res.headersSent) sendJson(res, { message: "the broker failed" }, 500);
      else res.destroy();
    }
  };
}

export function createBrokerServer(options) {
  return drainable(createServer(withRequest(createBrokerHandler(options))));
}
