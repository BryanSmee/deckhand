// Edge's public HTTP server (#506), the only one the internet reaches: GitHub's webhooks, /setup,
// sign-in (the dashboard's, and MCP clients', oauth.mjs), the dashboard's files, and its API,
// /status, which it passes on to the orchestrator with the signed-in user (forward.mjs), and the
// runs' screenshots, which it passes on to the broker (shots.mjs, #609).
//
// A delivery is verified (its HMAC), taken once (its GUID set-if-absent in edge's store, which
// both copies share: one GitHub sends twice, or that reaches both, goes on once), then put on
// the `deliveries` stream before it is answered: the orchestrator reads it from there and
// acknowledges it once handled (internal.mjs), so none is lost while it hands over.
import { createServer } from "node:http";
import { authPage } from "../listener/auth.mjs";
import { createSlots, readDelivery, sourceOf } from "../listener/deliveries.mjs";
import { quietPayload, verified } from "../listener/events.mjs";
import { QUIET_EVENTS } from "../listener/github-app.mjs";
import { serveAsset } from "../listener/static.mjs";
import { drainable } from "../lib/drain.mjs";
import { readBody } from "../lib/http.mjs";
import { storable } from "../lib/store.mjs";
import { ciWaitingKey, DELIVERIES } from "./internal.mjs";
import { logContext, withRequest } from "../lib/log.mjs";

// On every answer: the dashboard's own scripts, styles and images only (its build has no
// inline script), never in a frame (a page on a sibling domain, which SameSite=Lax lets
// through, could get a signed-in user to click Start or Cancel), and never sniffed as another
// type. Edge's own pages narrow the policy further (html.mjs page()).
export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

// GitHub's own cap is 25 MB, far above the events Deckhand takes: comments, pull requests,
// workflow runs. Only a push with many commits could be larger, and a push refused only delays
// a config's refresh (repos.mjs reads it again within 30 minutes).
const MAX_DELIVERY = 5 * 1024 * 1024;
// Deliveries read at once before their signature is checked: GitHub sends a few at a time, from
// many addresses. One address gets a share of the places (deliveries.mjs).
const MAX_UNVERIFIED = 16;
const PER_SOURCE = 4;
// A reader this old may lose its place to a new delivery: GitHub's bodies take milliseconds.
const GRACE_MS = 1000;
const IDLE_MS = 2000;
const BODY_MS = 10000;
// The dashboard's posts are small: a comment, an answer, a discussion.
const MAX_API_BODY = 1024 * 1024;
// The most deliveries the stream keeps unread (far more than a handover leaves); one the
// orchestrator acknowledged goes from it at once (internal.mjs).
const STREAM_MAX = 10_000;

// Health checks and scripts call from inside the container (docker compose exec). A reverse
// proxy on the host's network calls from loopback too, for anyone: a request it forwarded
// (it says so in a header) isn't local.
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
export function local(req) {
  if (FORWARDED.some((h) => req.headers[h] !== undefined)) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}

// A delivery's GUID, as the store keeps it: { taking: at } while it goes on the stream, then
// { kept: at }, for a day. A redelivery of one taken (by hand, or GitHub's own) comes within that;
// the redeliveries' poller only asks for those GitHub never saw taken.
export const deliveryKey = (id) => `deliveries/${id}`;
export const DELIVERY_TTL_MS = 24 * 3600_000;
// How long a commit's mark (internal.mjs ciWaitingKey()) lasts, should its entry be lost.
const CI_WAITING_TTL_MS = 10 * 60_000;
// A delivery still being taken after this was lost on its way to the stream (a copy that died,
// a store that failed twice): taken again.
const TAKING_MS = 60_000;

// Whether edge took the delivery with this GUID (the redeliveries ask it, ../listener/
// redeliveries.mjs `handled`): kept, or being taken now.
export async function takenDelivery(store, id, now = Date.now) {
  const mark = await store.get(deliveryKey(id));
  return !!mark && (mark.kept != null || now() - (mark.taking ?? 0) < TAKING_MS);
}

// Marks it as being taken, once: false when another copy (or GitHub's second send) has it.
async function startTaking(store, id, now) {
  const key = deliveryKey(id);
  const mark = { taking: now() };
  if (await store.setIfAbsent(key, mark, { ttlMs: DELIVERY_TTL_MS })) return true;
  const found = await store.get(key);
  if (!found || found.kept != null || now() - (found.taking ?? 0) < TAKING_MS) return false;
  return store.compareAndSet(key, found, mark, { ttlMs: DELIVERY_TTL_MS });
}

// `app`: app.mjs's; `auth`, `setup`: ../listener/auth.mjs's and setup.mjs's; `oauth`: MCP
// clients' sign-in (oauth.mjs), none: not served; `orchestrator`:
// forward.mjs's; `shots`: shots.mjs's; `redeliveries`: whether a delivery is one edge asked again (redelivered());
// `dashboardDir`: the dashboard's build; `stopping()`: true once SIGTERM came.
export function createEdgeHttp({
  config,
  app,
  auth,
  setup,
  oauth = null,
  store,
  orchestrator,
  shots,
  redeliveries,
  dashboardDir,
  secrets = () => [],
  stopping = () => false,
  log = () => {},
  now = Date.now,
}) {
  // Bodies being read before their signature can be checked: a public port, so capped.
  const unverified = createSlots({ total: MAX_UNVERIFIED, share: PER_SOURCE, graceMs: GRACE_MS });

  const refuse = (res, status, why, text) => {
    log(`Rejected a delivery: ${why}`);
    // The body isn't read: the connection isn't reused for another request.
    res.writeHead(status, { connection: "close" });
    res.end(text);
    return true;
  };

  // What can be refused from the headers alone, before reading the body: answered and true.
  function refusedEarly(req, res) {
    // Failed on GitHub's side, where it can be redelivered, rather than lost.
    if (stopping()) return refuse(res, 503, "stopping", "restarting");
    if (!app.get()) return refuse(res, 503, "no GitHub App yet (open /setup)", "not set up");
    if (!req.headers["x-hub-signature-256"]) {
      return refuse(res, 401, "no signature (not from this Deckhand's App)", "bad signature");
    }
    if (Number(req.headers["content-length"]) > MAX_DELIVERY) {
      return refuse(res, 413, `over ${MAX_DELIVERY} bytes`, "too large");
    }
    return false;
  }

  function webhook(req, res) {
    if (refusedEarly(req, res)) return;
    const source = sourceOf(req.socket.remoteAddress);
    const release = unverified.take(source, () =>
      req.destroy(new Error("its place taken by a newer delivery")),
    );
    if (!release) return refuse(res, 503, `no place to read a delivery from ${source}`, "busy");
    readDelivery(req, { limit: MAX_DELIVERY, idleMs: IDLE_MS, totalMs: BODY_MS })
      .finally(release)
      .then(
        (body) => accept(req, res, body),
        (error) => log(`Rejected a delivery: ${error.message}`),
      )
      .catch((error) => {
        (log.error ?? log)(`A delivery: ${error.stack ?? error}`);
        if (!res.headersSent) refuse(res, 503, "not kept", "try again");
      });
  }

  // A delivery read whole: verified, taken once, on the stream, then answered. Not on it (the
  // store away): 503, which GitHub marks failed and the redeliveries ask again.
  async function accept(req, res, body) {
    if (stopping()) return refuse(res, 503, "stopping", "restarting");
    const secret = app.get()?.webhook_secret;
    if (!secret || !verified(secret, req.headers["x-hub-signature-256"], body)) {
      return refuse(res, 401, "bad signature (not from this Deckhand's App)", "bad signature");
    }
    const event = req.headers["x-github-event"];
    // A commit's CI changed (github-app.mjs QUIET_EVENTS): no log line, nor a place in the
    // store's delivery ids, so taken without its GUID.
    const quiet = QUIET_EVENTS.has(event);
    const id = (!quiet && req.headers["x-github-delivery"]) || null;
    let payload;
    let waiting = null;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return res.writeHead(202).end();
    }
    if (quiet) {
      // Only what the orchestrator reads of it, for an allowed repo, and one waiting per commit.
      payload = quietPayload(config, event, payload);
      if (!payload) return res.writeHead(202).end();
      const { full_name } = payload.repository;
      const sha = payload.sha ?? payload.check_suite.head_sha;
      waiting = ciWaitingKey(full_name, sha);
      if (!(await store.setIfAbsent(waiting, { at: now() }, { ttlMs: CI_WAITING_TTL_MS }))) {
        return res.writeHead(202).end();
      }
    }
    // Deliveries without a GUID are taken.
    if (id && !(await startTaking(store, id, now))) {
      log(`Delivery ${id} again: already handled`);
      return res.writeHead(202).end();
    }
    try {
      const redelivered = id ? await redeliveries.redelivered(id) : false;
      // What people wrote may hold a token pasted by mistake: kept without it, as the queue is.
      // With its request's ID: the orchestrator's lines about it carry it too.
      const { request } = logContext();
      const entry = storable({ id, event, payload, redelivered, request, at: now() }, secrets());
      await store.append(DELIVERIES, entry, { maxLength: STREAM_MAX });
    } catch (error) {
      // Not taken after all: GitHub's redelivery, or the next scan's, is. A mark the store
      // couldn't remove either is taken again once a minute old.
      if (id) await store.delete(deliveryKey(id)).catch(() => false);
      if (waiting) await store.delete(waiting).catch(() => false);
      throw error;
    }
    // On the stream: taken, whatever this write does. Refused now, GitHub would send it again,
    // and its mark, left "taking", would let that second one through a minute on.
    if (id) {
      await store
        .set(deliveryKey(id), { kept: now() }, { ttlMs: DELIVERY_TTL_MS })
        .catch((error) =>
          log(`Delivery ${id}: its mark (${error.message ?? error}), kept as taking`),
        );
    }
    if (!quiet) log(`Passed on: ${event} ${payload?.action ?? ""} (${id ?? "no id"})`);
    res.writeHead(202).end();
  }

  // The dashboard's page, its sign-in before it, and its files.
  function serveDashboard(req, res, user) {
    const url = new URL(req.url, "http://localhost");
    if (!app.get()) {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end("Deckhand: up, no GitHub App yet. Open the /setup link from edge's logs.\n");
    }
    if (!user) {
      if (url.pathname !== "/") return res.writeHead(401).end();
      return authPage(
        res,
        200,
        "Deckhand",
        `<p>Runs, brainstorms and their live logs, for this Deckhand's allowed users.</p>
<p><a class="button" href="/auth/login">Sign in with GitHub</a></p>`,
      );
    }
    if (serveAsset(res, dashboardDir, url.pathname)) return;
    res.setHeader("cache-control", "no-store");
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res
        .writeHead(503)
        .end(
          `Deckhand: the dashboard isn't built (${dashboardDir}): run npm run build in dashboard/.\n`,
        );
    }
    res.writeHead(404).end();
  }

  // The orchestrator's to answer, with who asks: a signed-in user, or a local caller (/status).
  async function forward(req, res, { user = null, isLocal = false, still = null } = {}) {
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, MAX_API_BODY);
    return orchestrator.forward(req, res, { user, local: isLocal, body, still });
  }

  async function route(req, res) {
    const path = req.url.split("?")[0];
    // A path with dot segments, or a backslash (which fetch() takes for a slash in an http: URL):
    // fetch() would resolve them before the orchestrator saw it, which would then answer another
    // path than the one edge routed. None of the dashboard's has either.
    if (/\\|%5c/i.test(path) || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path)) {
      return res.writeHead(400).end();
    }
    if (req.method === "GET" && path === "/health") return res.end("ok");
    // Public, like any image in a GitHub comment; the folder token is the only protection.
    if (req.method === "GET" && path.startsWith("/shots/")) return shots.serve(req, res);
    if (setup.handle(req, res)) return;
    if (auth.handle(req, res)) return;
    // Before the API: Settings' list of MCP clients is edge's own, their tokens in its store.
    if (oauth?.handle(req, res)) return;
    if (req.method === "POST" && path === "/webhook") return webhook(req, res);
    if (path === "/status") {
      if (local(req)) return forward(req, res, { isLocal: true });
      const user = await auth.user(req);
      if (!user) return res.writeHead(401).end();
      return forward(req, res, { user });
    }
    if (path.startsWith("/api/")) {
      if (!app.get()) return res.writeHead(503).end();
      const user = await auth.user(req);
      // A live log stops once its user signs out (or leaves ALLOWED_USERS), as it did before.
      const still = user ? async () => (await auth.user(req)) === user : null;
      return forward(req, res, { user, still });
    }
    // GitHub only ever POSTs to /webhook; everything a browser asks for is the dashboard.
    if (req.method === "GET") return serveDashboard(req, res, await auth.user(req));
    res.writeHead(404).end();
  }

  // One request's unexpected throw answers 500 and is logged: it never takes edge down.
  // Each request under an ID of its own (lib/log.mjs), never one the internet sent: what it logs
  // here, and what the orchestrator does with it, carry it.
  const handle = withRequest(
    (req, res) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      route(req, res).catch((error) => {
        (log.error ?? log)(`${req.method} ${req.url.split("?")[0]}: ${error.stack ?? error}`);
        if (!res.headersSent) res.writeHead(error.status === 503 ? 503 : 500);
        res.end();
      });
    },
    { trusted: false },
  );

  function listen(port = config.port) {
    const web = drainable(createServer(handle));
    web.listen(port, () => {
      // PORT=0 (the tests): the OS picks a free port, logged for whoever started edge.
      config.port = web.address().port;
      log(`Listening on :${config.port}`);
    });
    return web;
  }

  return { handle, listen };
}
