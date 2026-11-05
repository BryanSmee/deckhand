// Edge's internal port (#506): what the orchestrator calls it for, on the network they share
// alone (compose.yaml), never on the public port:
//
//   GET  /events?wait=ms       the verified deliveries it hasn't acknowledged (a long poll): the
//                              `deliveries` stream of edge's store, which both copies share
//   POST /events/ack           { ids }: handled, never read again
//   GET  /app                  the App's public parts (app.mjs publicPart()), and where the
//                              dashboard is: what the orchestrator names in its links
//   POST /from-tags            { items: [{ user, text }] } → { tags }: the dashboard's "from"
//                              lines' tags (../listener/discussions.mjs fromLine()), which the key
//                              derived from the webhook secret signs: the orchestrator holds none
//   POST /redeliveries/scan    the deliveries GitHub couldn't hand over, asked again now (the
//                              dashboard's Sync) → { count }
//   GET  /health               { ok, startedAt, version } (../lib/health.mjs), without a token:
//                              the orchestrator's status page
//
// Each other route takes the orchestrator's service token alone (serviceGuard()).
import { createServer } from "node:http";
import { drainable } from "../lib/drain.mjs";
import { healthAnswer, healthInfo } from "../lib/health.mjs";
import { readJsonBody, Refused, sendJson } from "../lib/http.mjs";
import { serviceGuard } from "../lib/service-token.mjs";
import { fromKey, fromTag } from "../listener/discussions.mjs";
import { QUIET_EVENTS } from "../listener/github-app.mjs";
import { withRequest } from "../lib/log.mjs";

export const ROUTES = {
  "GET /events": ["orchestrator"],
  "POST /events/ack": ["orchestrator"],
  "GET /app": ["orchestrator"],
  "POST /from-tags": ["orchestrator"],
  "POST /redeliveries/scan": ["orchestrator"],
};

// The stream verified deliveries go on, and its one consumer: the orchestrator's copies take
// turns reading it (lib/store.mjs, active/passive).
export const DELIVERIES = "deliveries";
const CONSUMER = "orchestrator";
// A commit whose CI changed (QUIET_EVENTS) with an entry on the stream the orchestrator hasn't
// read yet: { at }, cleared when it reads it (events()). The next ones for that
// commit go on no stream until then: that entry's handling reads the commit's CI after them
// anyway. So statuses, one per state of each context, never crowd out the deliveries that
// matter under STREAM_MAX, while the orchestrator is away too.
export const ciWaitingKey = (repo, sha) => `ci-waiting/${repo.toLowerCase()}@${sha}`;
// The orchestrator's long poll: under its own timeout.
export const EVENTS_WAIT_MS = 20_000;
const MAX_BODY = 1024 * 1024;
const MAX_TAGS = 1000;

// `app`: app.mjs createEdgeApp()'s; `keys`: the broker's public keys ({ get(kid) });
// `bound`: lib/service-token.mjs networkCallers()'s, or null on Kubernetes; `redeliveries`:
// ../listener/redeliveries.mjs's.
export function createEdgeInternal({
  store,
  app,
  keys,
  bound,
  redeliveries,
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // What GET /health says: when it started, its version (../lib/health.mjs).
  health = healthInfo(),
}) {
  const guard = serviceGuard({ service: "edge", keys, routes: ROUTES, bound, now });

  async function events(res, url) {
    const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, EVENTS_WAIT_MS);
    const until = now() + wait;
    let gone = false;
    res.on("close", () => (gone = true));
    for (;;) {
      const found = await store.read(DELIVERIES, CONSUMER, { count: 50 });
      if (found.length || gone || now() >= until) {
        await readCi(found);
        return sendJson(res, { events: found });
      }
      await sleep(Math.min(250, until - now()));
    }
  }

  // The commits whose CI entry the orchestrator reads now: the next status for one goes on the
  // stream again (ciWaitingKey()), its handling coming after this one's.
  async function readCi(found) {
    for (const { event } of found) {
      if (!QUIET_EVENTS.has(event?.event)) continue;
      const repo = event.payload?.repository?.full_name;
      const sha = event.payload?.sha ?? event.payload?.check_suite?.head_sha;
      if (typeof repo === "string" && typeof sha === "string") {
        await store.delete(ciWaitingKey(repo, sha));
      }
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://edge");
    // The orchestrator's status page's, without a token, as every service's (../lib/health.mjs).
    if (req.method === "GET" && url.pathname === "/health")
      return sendJson(res, healthAnswer(health));
    guard(req);
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /events") return events(res, url);
    if (route === "POST /events/ack") {
      const { ids } = (await readJsonBody(req, MAX_BODY)) ?? {};
      // Handled: gone from the stream, its payload with it (what people wrote isn't kept on).
      const acked = await store.ack(
        DELIVERIES,
        CONSUMER,
        Array.isArray(ids) ? ids.map(String) : [],
        { drop: true },
      );
      return sendJson(res, { acked });
    }
    if (route === "GET /app") return sendJson(res, app.info());
    if (route === "POST /from-tags") {
      const { items } = (await readJsonBody(req, MAX_BODY)) ?? {};
      if (!Array.isArray(items) || items.length > MAX_TAGS) throw new Refused(400, "items?");
      const key = fromKey(app.get()?.webhook_secret);
      const tags = items.map((item) =>
        key && typeof item?.user === "string" && typeof item?.text === "string"
          ? fromTag(key, item.user, item.text)
          : null,
      );
      return sendJson(res, { tags });
    }
    if (route === "POST /redeliveries/scan") {
      return sendJson(res, { count: await redeliveries.scan() });
    }
    throw new Refused(404, "no such endpoint");
  }

  return drainable(
    createServer(
      withRequest((req, res) =>
        handle(req, res).catch((error) => {
          if (res.headersSent) return res.destroy();
          if (error instanceof Refused)
            return sendJson(res, { message: error.message }, error.status);
          (log.error ?? log)(
            `Edge's internal port: ${req.method} ${req.url}: ${error.stack ?? error}`,
          );
          sendJson(res, { message: error.message ?? "failed" }, 500);
        }),
      ),
    ),
  );
}
